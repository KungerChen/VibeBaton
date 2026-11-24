# Master RFC: Stage 5 (v1.1.0) — Multi-Specialist Panel Mode & Cost-Balanced Tier Defaults

## Goals

Expand VibeBaton beyond fixed single-spec feature pipelines into **open-ended collaborative diagnosis, architecture review, UX/copy polish, and multi-perspective synthesis** (`00_PANEL` -> `Synthesizer` -> `01_PLAN` -> Execution & Gates), while shifting out-of-the-box defaults to cost-balanced upper-mid models for thinking/review and fast economical models for synthesis & repetitive implementation:

1. **Declarative `[panel]` Configuration & Cost-Balanced Model Tiers (`config.py`, `allocation.py`, `baton.example.toml`)**:
   - Add `PanelMemberConfig` and `PanelSettings` parsed cleanly from an optional `[panel]` section in `baton.toml`.
   - Expand `_MODEL_COST_TIERS` in `config.py` so `hydrogen` classifies cleanly as `"eco"` (`4H` / `gemini-4-hydrogen-high`), `sonnet`, `neon`, and `sol` classify as `"standard"` upper-mid tier, and `astra`, `fable`, `flagship`, `opus`, and `pro` remain `"flagship"`.
   - Update `baton.example.toml` defaults so everyday roles and the example `[panel]` showcase **upper-mid specialists** (`claude_sub:opus@high`, `codex_sub:gpt-6.2-sol@max`, `host_native:gemini-4-neon-high` or HTTP/CLI equivalents) paired with **economical synthesizer & execution workers** (`claude_sub:sonnet@high`, `dsh_opencode:deepseek-v4.1-flash@max`, `gemini-4-hydrogen-high`), keeping `max_quality` allocation available for full flagship escalation.

2. **`00_PANEL` Parallel Read-Only Engine Phase (`panel.py`, `engine.py`, `cli.py`, `web_server.py`, `report.py`, `case_export.py`)**:
   - Introduce `src/vibebaton/panel.py` implementing pure-stdlib `run_panel_phase(...)`: runs configured specialist consultations concurrently in read-only isolation (never mutating repo files), saves individual transcripts to `.baton/runs/<run_id>/panel/<member_id>.md`, emits structured `panel_started` / `panel_member_completed` / `panel_synthesized` telemetry events (with full CLI/HTTP token & USD billing), and passes all specialist briefs into a structured **Synthesizer** guided by deterministic arbitration precedence (`source-code truth & security boundaries > architectural simplicity > copy & visual refinement`) to produce `.baton/runs/<run_id>/panel/master_spec.md`.
   - Support `--mode panel` in `baton run` (and `mode = "panel"` in `POST /api/runs/start`), seamlessly feeding `master_spec.md` into `01_PLAN` (`_ensure_plan`) and surfacing `00_PANEL` timings, summaries, and sanitized panel transcripts across live telemetry, bilingual battle reports, and `.baton-case.json` exports.

3. **Official 8th Workflow Preset (`specialist_panel`) & Studio Panel Support (`presets/`, `web/`)**:
   - Ship `presets/specialist_panel.baton.json` (and matching TypeScript preset `web/src/data/presets/specialist_panel.ts`) illustrating the 8-node/multi-specialist workflow (`Parallel Specialists ×3 -> Synthesizer -> Isolated Workers -> Mechanical Gate -> AI Review -> Human Sign-Off`) with `category: "panel"`, valid against both Python `validate_graph` and TypeScript `validateGraph`.
   - Add a `panel` category filter in Studio's Recipe Plaza, a `Specialist Panel + Execute` (`mode: "panel"`) run option in `StartRunModal`, and `00_PANEL` stage/node visualization in `LiveRunPanel` and `liveRunGraph.ts` with complete `EN | 中文` parity.

4. **Publish `v1.1.0` Release & Verified Documentation**:
   - Bump versions cleanly to `1.1.0`, append `## [v1.1.0] - 2026-11-23` in `CHANGELOG.md`, update `docs/ROADMAP.md`, `docs/TUTORIAL.md`, `README.md`, and `README.zh-CN.md`, and keep all frontend and backend test suites green.

## Constraints

- **Zero new Python runtime dependencies**: `panel.py`, `config.py`, `engine.py`, `cli.py`, `web_server.py`, `report.py`, and `case_export.py` must use Python 3.11+ standard library modules only (`asyncio`, `dataclasses`, `json`, `pathlib`, `re`, `time`).
- **Zero new npm dependencies**: Do NOT run `npm install` or edit `web/package-lock.json`; only bump `"version": "1.1.0"` in `web/package.json`. On Windows, run frontend checks with `npx.cmd` and `npm.cmd`.
- **Strict Read-Only Specialist Boundary**: Panel specialist invocations run strictly read-only on `self.repo_path` (without creating dirty edits or touching working tree files); if any single specialist member fails cleanly, log the member failure without crashing if at least one specialist report succeeds for synthesis (fail the run only when zero specialist reports succeed or synthesis fails).
- **Backward Compatibility & Existing Mode Invariants**:
  - When `[panel]` is omitted or `mode` is `"overnight"` or `"interactive"`, existing execution semantics, test mocks, legacy battle report byte stability (when no panel events exist), and `stage1Replay` traces remain completely unchanged.
  - All 7 existing workflow presets (`starter_2tier`, `solo_coder_3tier`, `claude_only_3tier`, `codex_only_3tier`, `deepseek_bulk_factory`, `flagship_4tier`, `review_only_audit`) keep their exact IDs, node counts, and passing unit tests; existing `.baton/baton.toml` continues to parse without error.
- **UI, i18n & Security Invariants**:
  - Maintain pure English in `MESSAGES.en` (zero CJK), >=1 Han character in all `MESSAGES.zh` leaf strings (`QUICK_START_IDENTIFIERS` excluded), `"DSH"` display naming consistency, and zero `/opencode/i` in UI strings (`web/src/i18n/i18n.test.ts`).
  - Keep `tests/test_release_collateral.py` invariants intact (`1.0.0`, `sandbox init`, `scripts/install.ps1`, zero `sk-[A-Za-z0-9]{20,}`, oldest-first `CHANGELOG.md` headings).
  - Case export redaction (`case_export.py`) must continue scrubbing any panel/synthesizer summaries through all 4 firewall layers (`redaction_report.clean == True`).

## Non-Goals

- Do NOT grant write tools or create Git worktrees for read-only `00_PANEL` specialist members (all repo modifications happen strictly downstream in `01_PLAN` -> M1..Mn worktrees behind mechanical gates).
- Do NOT break or remove existing `"interactive"` and `"overnight"` CLI/REST modes, and do NOT force `[panel]` execution when the user does not request `"panel"` mode.
- Do NOT introduce interactive stdin prompts or new external network services.

## Architecture & Deliverables (Milestones M1–M3)

### M1: Backend `[panel]` Config, `00_PANEL` Parallel Engine Phase, CLI, REST API & Case Export

- **`src/vibebaton/config.py` & `src/vibebaton/allocation.py`**:
  - Add `@dataclass class PanelMemberConfig` (`id: str`, `perspective: str`, `provider: str`, `model: str`, `prompt_file: str = "prompts/panel_specialist.md"`, `fallback: list[FallbackTarget]`) and `@dataclass class PanelSettings` (`enabled: bool = False`, `max_concurrency: int = 3`, `synthesizer_provider: str = "claude_sub"`, `synthesizer_model: str = "sonnet@high"`, `synthesizer_prompt_file: str = "prompts/panel_synthesizer.md"`, `arbitration_rules: list[str]`, `members: list[PanelMemberConfig]`), defaulting cleanly to an empty-or-defaultable panel when `[panel]` is omitted.
  - Parse optional `[panel]` and `[[panel.members]]` tables in `parse_config_dict(...)` (with full validation of member IDs, non-empty perspectives, and fallback normalization).
  - Update `_MODEL_COST_TIERS` in `config.py` (`("eco", ("flash", "haiku", "lite", "mini", "nano", "hydrogen"))`, keep `("flagship", ("astra", "fable", "flagship", "opus", "pro"))`, treating `sonnet`, `neon`, and `sol` cleanly as `"standard"`), and preserve `allocation.py` budget escalation compatibility.
- **`prompts/panel_specialist.md` & `prompts/panel_synthesizer.md`**:
  - Author focused, provider-agnostic Markdown prompts: specialists audit the target repository read-only from their assigned perspective and deliver concise structured recommendations; synthesizer resolves disagreements under explicit arbitration precedence (`verified code/security truth > simplicity & restraint > UX/polish`) and outputs an actionable specification ready for `PlanDAG` compilation.
- **`src/vibebaton/panel.py`**:
  - Implement deterministic `build_default_panel_settings(cfg: BatonConfig) -> PanelSettings` (derives sensible ready specialists from configured providers when `--mode panel` runs without an explicit `[panel]` section) and async `run_panel_phase(...) -> PanelPhaseResult`:
    - Dispatches each `PanelMemberConfig` concurrently bounded by `asyncio.Semaphore(settings.max_concurrency)` via `invoke_provider` (honoring SQLite quota cooldowns and role fallbacks, writing each specialist's output to `.baton/runs/<run_id>/panel/<member_id>.md`, and storing truncated safe output previews only).
    - Emits structured SQLite events (`panel_started`, `panel_member_completed`, `panel_synthesized`) with token/USD billing fields compatible with existing `report.py` billing extractors.
    - Invokes the configured Synthesizer (`synthesizer_provider` / `synthesizer_model`, supporting `host_native` or configured CLI/HTTP providers) to merge specialist reports + original RFC into `.baton/runs/<run_id>/panel/master_spec.md` and returns synthesized context + stats (`member_count`, `succeeded_count`, `elapsed_sec`, `master_spec_path`).
- **`src/vibebaton/engine.py`, `cli.py`, `web_server.py`, `report.py`, `case_export.py`, `schemas.py`**:
  - Support `mode="panel"` across CLI (`baton run --mode panel`, adding `"panel"` to `--mode` choices alongside `"interactive"` and `"overnight"`), REST API (`POST /api/runs/start`), and `OrchestrationEngine.run(...)`: when `run["mode"] == "panel"` (or explicit `cfg.panel.enabled and run["mode"] == "panel"`), execute `00_PANEL` before `01_PLAN`, feed `master_spec.md` alongside the original RFC into `_ensure_plan(...)`, and skip re-running `00_PANEL` on resume if `master_spec.md` already exists.
  - Record `"00_PANEL"` in `compute_run_telemetry` (`stages` dict), render the concise Panel & Synthesis summary in bilingual `generate_battle_report` when `panel_*` events exist (preserving byte-exact legacy output when absent), and include sanitized `"00_PANEL"` events in `case_export.py` scrubbed through the 4-layer redaction firewall.
- **`tests/test_panel.py`**:
  - Comprehensive unit & integration tests covering `[panel]` config parsing, `_MODEL_COST_TIERS` tier classification (`hydrogen`/`sonnet`/`neon`/`sol`), parallel CLI + HTTP mock panel execution, single-member failure resilience, zero-member failure handling, synthesizer `master_spec.md` creation & `01_PLAN` handoff, `--mode panel` CLI & REST API launch, `00_PANEL` telemetry/battle report/redacted case export, and zero regression on `"overnight"` runs.

### M2: Official 8th Preset (`specialist_panel`), Cost-Balanced Defaults & Studio Panel UI

- **`baton.example.toml`**:
  - Update default `[roles.*]` model recommendations to cost-balanced upper-mid & economical defaults (`tactical_planner = "claude_sub:opus@high"` / `critical_executor = "codex_sub:gpt-6.2-sol@max"`, `micro_orchestrator = "codex_sub:gpt-6.2-sol@high"` or `claude_sub:sonnet@high`, `bulk_worker = "dsh_opencode:deepseek-v4.1-flash@max"`), keeping existing provider templates (`claude_sub`, `codex_sub`, `dsh_opencode`) working cleanly, and add a documented `[panel]` + `[[panel.members]]` block demonstrating the 3-specialist round-table + `sonnet@high` synthesizer pattern.
- **`presets/specialist_panel.baton.json` & `web/src/data/presets/specialist_panel.ts` (+ `specialist_panel.test.ts`)**:
  - Add the **8th official workflow preset** (`id: "specialist_panel"`, `category: "panel"`, `cost_tier: "medium"`), modeling: RFC -> 3 parallel Specialist Reviewers (`UX & Copy`, `Visual & Structure`, `Source & Safety`) -> Synthesizer -> Worker Implementation -> Mechanical Gate -> Reviewer -> Human Sign-Off, passing `validate_graph` (Python) and `validateGraph` (TypeScript) plus offline simulations (`happy_path`, `gate_retry`, `escalate`) with 0 errors and 0 warnings.
  - Update `web/src/types/graph.ts` (`PresetCategory` adding `'panel'`, `LaunchRunRequest` mode adding `'panel'`), `web/src/components/recipePlaza.ts` (+ `recipePlaza.test.ts`), and `web/src/presets` / `presets.py` (`_default_category` / category filter integration).
- **Studio UI & i18n (`StartRunModal.tsx`, `LiveRunPanel.tsx`, `liveRunGraph.ts`, `client.ts`, `messages.ts`, `i18n.test.ts`)**:
  - Add `panel` category pill in `LeftSidebar` Recipe Plaza (`Panel & Execute` / `会诊协作`).
  - Add a **Run Mode** selector in `StartRunModal` (`Overnight Pipeline` vs `Specialist Panel + Execute`), sending `mode: 'panel'` cleanly to `POST /api/runs/start` (and mock demo mode cleanly).
  - Support `00_PANEL` stage card in `LiveRunPanel` Stage Timing + `liveRunGraph.ts` live run DAG synthesis when `00_PANEL` timing/events exist.
  - Ensure complete `EN | 中文` parity in `web/src/i18n/messages.ts` satisfying `i18n.test.ts`.

### M3: Version `1.1.0`, Documentation Updates & Full Verification

- **Version Bump (`1.1.0`)**:
  - Update `pyproject.toml`, `src/vibebaton/__init__.py`, `web/package.json`, `tests/test_version_consistency.py` cleanly to `1.1.0` (do NOT modify `web/package-lock.json`).
- **Release Docs (`CHANGELOG.md`, `docs/ROADMAP.md`, `docs/TUTORIAL.md`, `README.md`, `README.zh-CN.md`)**:
  - Append `## [v1.1.0] - 2026-11-23` to `CHANGELOG.md` after `v1.0.4` (oldest-first order preserved).
  - Document Stage 5 (`v1.1.0`) Specialist Panel mode and updated tier defaults concisely across `docs/ROADMAP.md`, `docs/TUTORIAL.md`, `README.md`, and `README.zh-CN.md` (preserving all `test_release_collateral.py` invariants: `1.0.0`, `sandbox init`, `scripts/install.ps1`, zero `sk-[A-Za-z0-9]{20,}`).
- **M3 Mechanical Verification**:
  - Run full frontend suite (`vitest run`, `tsc --noEmit`, `vite build`) and full backend suite (`python -m unittest discover -s tests -v`).

## Verification & Acceptance Criteria

Run all verification commands sequentially without shell races:

```bash
cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"
cmd /c "set PYTHONPATH=src&& set PYTHONUTF8=1&& set VIBEBATON_DISABLE_PRICING_SYNC=1&& python -m unittest discover -s tests -v"
```

1. `tests/test_panel.py` passes all unit and integration tests for `[panel]` parsing, `_MODEL_COST_TIERS` classification, concurrent CLI/HTTP specialist execution, fault tolerance, `master_spec.md` synthesis feeding `01_PLAN`, `00_PANEL` telemetry/report/sanitized case export, and CLI/REST `mode="panel"`.
2. `python -m vibebaton presets --validate` passes all 8 presets (including `specialist_panel`) with `valid=True`, `errors=0`, and `warnings=0`.
3. `tests/test_version_consistency.py` and `tests/test_release_collateral.py` pass for `1.1.0`, `python -m vibebaton --version` prints `vibebaton 1.1.0`, and `python -m vibebaton run --help` includes `panel` in `--mode`.
4. Frontend `npx.cmd vitest run`, `npx.cmd tsc --noEmit`, and `npm.cmd run build` exit `0` with `i18n.test.ts`, `recipePlaza.test.ts`, and `specialist_panel.test.ts` green.
5. Full backend `python -m unittest discover -s tests -v` passes all tests cleanly with `0` failures.
6. `[panel]` parsing and `baton run --mode panel` work cleanly on `baton.example.toml` defaults while existing `overnight` / `interactive` configs remain 100% backward compatible.
