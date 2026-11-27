# VibeBaton Guided Mode 2.0: Blueprint-First Workflow & Commit-Lineage Loop

> Archived 2026-11-27. This RFC drove Guided Mode 2.0 (M1-M3, accepted by the user on 2026-11-27). It was superseded in `.baton/00_RFC.md` by the Studio Workbench Phase 1 RFC.

## Goals

1. **4-Stage Server-Persisted Guided Loop**: Reorder Guided Mode into a 4-stage closed loop (`Workspace & Toolkit -> Blueprint & Workflow Launch -> Live Build -> Sign-Off & Iteration`) with guided session drafts and active UI state persisted to `.baton/guided/session.json` so browser refreshes and reconnects restore the exact workspace, brainstorm draft, workflow selection, or build/human-gate view.
2. **Streamlined Step 1 (`GuidedSetupStep.tsx`)**: Keep project folder selection, Git repository initialization, and AI coding CLI scanning on one screen; remove the 6-role lineup table from Step 1; collapse CLI cards into a compact status summary bar when `readyCount >= 1`; replace checkbox-gated installation with an inline command-confirmation popover, transition installed CLI cards directly into a highlighted `[Sign in]` action, and automatically re-scan on `window.focus` after login completes.
3. **Resilient Step 2 (`GuidedBrainstormStep.tsx` & `brainstorm.py`)**:
   - Add a top-bar L0 model switcher that auto-selects the strongest ready model and displays the actual responding model name for each turn.
   - Inject the current latest RFC draft into `_build_prompt` so switching L0 models mid-session preserves full context without blueprint drift.
   - Enforce an offline-protection guard so once an online blueprint draft exists in the session, transient online request errors never overwrite it with an offline fallback template (preserve the previous draft and offer retry).
   - Add a 1-turn revision fast-track when re-entering Step 2 from Sign-Off (`what`, `who`, `scope`, `limits`, and `done` checklist items pre-marked `clear` with the prior RFC and requested changes injected).
4. **Blueprint-Bottom Workflow Recommendation & Inline Lineup Customization**:
   - Allow `size: "small" | "medium" | "large"` in the brainstorm `guide` block parser in `src/vibebaton/brainstorm.py`.
   - Add deterministic backend `recommend_workflow()` combining the `size` signal with real host provider/credential readiness: map `small` to an eco fast model preset on `overnight`, `medium` to the standard tiered relay on `overnight`, and `large` to `panel` mode only when preflight confirms at least 1 panelist and Synthesizer credentials are ready (otherwise fall back to `overnight` with an explicit explanation).
   - Render an inline launch bar and expandable lineup drawer at the bottom of the Blueprint Card once `ready_to_launch` is true, reusing existing role/provider/model/effort selectors, saved lineup profiles, a Panel toggle, and an idempotent launch request ID. On iteration 2+, preserve the previous run's lineup by default (re-validated) and display a non-intrusive switch pill if the recommended size changed.
5. **Non-Blocking Live Build & Sign-Off (`GuidedWorkbench.tsx` & `GuidedSignOffPanel.tsx`)**:
   - Replace the blocking `WAITING_HUMAN` modal with a non-blocking right-side drawer so users can inspect task nodes, logs, and diffs while making decisions.
   - Add an explicit `FAILED` guidance banner and a safe "Stop & Replan" action that halts scheduling cleanly, waits for in-flight writes to settle, marks the run terminal, and returns to Step 2 with failure context.
6. **Commit-SHA Lineage & Run-Scoped RFC Snapshots (`db.py`, `git_ops.py`, `engine.py`, `web_server.py`)**:
   - Persist immutable per-run RFC snapshots at `.baton/runs/<run_id>/00_RFC.md` instead of overwriting a single global file across runs.
   - Add `parent_run_id`, `base_ref`, `start_sha`, and `result_sha` columns to the `runs` table and introduce terminal status `SUPERSEDED` so stale runs/tabs cannot be resumed or finalized and at most one active run executes per repository.
   - Align fresh runs to the current `main` HEAD SHA (eliminating stale `dev` branch drift from earlier failed or rolled-back runs).
   - Base `Request Changes` revision runs on the parent run's `result_sha` (`B`) while marking the parent run `SUPERSEDED` (never leaving it `PAUSED`).
   - Support `Approve & Merge` with a base-HEAD drift check (re-integrating in an isolated worktree and re-running gates if `main` advanced externally) and `Undo / Rollback` (unmerged: revert only current revision `C -> B` or abandon all unmerged changes back to `A`; merged: reset only when the merge commit is still `main` HEAD, otherwise guide a safe `git revert`).

## Constraints

- Keep the Python core zero external runtime dependencies (Python 3.11+ standard library only) and preserve backward compatibility with existing CLI commands, `baton.toml`, MCP tools, and existing SQLite databases via additive schema migrations.
- Preserve existing `.baton/baton.toml` provider definitions (`agy_sub`, `gemini_sub`, `claude_sub`, `codex_sub`, `dsh_opencode`, `gemini_http`).
- Maintain bilingual `EN | 中文` copy parity in `web/src/i18n/messages.ts` and preserve existing component and REST API compatibility.
- Keep all existing Python (`unittest`) and frontend (`vitest` and TypeScript/Vite build) checks passing alongside new test coverage.

## Non-Goals

- Redesigning Pro Mode canvas graph editing or changing the seven core DAG node types.
- Adding third-party Python runtime dependencies or external database engines.
- Auto-spawning external terminal windows for CLI login without explicit user confirmation.

## Architecture & Deliverables

- **Milestone 1 — Backend Lineage, Git Baseline & Run Lifecycle**:
  - `src/vibebaton/db.py`, `src/vibebaton/git_ops.py`, `src/vibebaton/engine.py`, and `src/vibebaton/web_server.py`.
  - Additive `runs` lineage columns (`parent_run_id`, `base_ref`, `start_sha`, `result_sha`), `SUPERSEDED` terminal state, immutable `.baton/runs/<run_id>/00_RFC.md` snapshots, fresh-run `main` SHA alignment, revision-run `result_sha` branching, external `main` advance detection during `Approve & Merge`, precise `C -> B` / `C -> A` / merged `Undo / Rollback` semantics, idempotent run launch, and unit/integration tests.
- **Milestone 2 — Brainstorm Hardening, Deterministic Workflow Recommendation & Session Persistence**:
  - `src/vibebaton/brainstorm.py` and `src/vibebaton/web_server.py`.
  - `.baton/guided/session.json` read/write/reset endpoints, L0 draft injection into `_build_prompt`, actual responding model reporting, offline-overwrite protection guard, revision fast-track mode, `size` field support in the `guide` parser, deterministic `recommend_workflow()` with Panel Synthesizer preflight, and backend unit/API tests.
- **Milestone 3 — Frontend Guided Mode 2.0 UI & End-to-End Loops**:
  - `web/src/components/guided/GuidedSetupStep.tsx`, `web/src/components/guided/GuidedBrainstormStep.tsx`, `web/src/components/guided/GuidedWorkbench.tsx`, `web/src/components/guided/GuidedSignOffPanel.tsx`, `web/src/api/client.ts`, and `web/src/i18n/messages.ts`.
  - Streamlined Step 1 (no 6-role table, collapsible CLI summary, inline install confirmation popover, login highlight + `window.focus` rescan), Step 2 top-bar L0 selector + bottom workflow launch bar/drawer + iteration 2+ switch pill, Step 3 non-blocking right-side human-gate drawer + `FAILED` banner + safe "Stop & Replan", Step 4 SHA-aware Sign-Off/Revision/Rollback actions, plus `vitest` tests and production build.

## Verification & Acceptance Criteria

1. Two consecutive revision rounds (`A -> B -> C`) allow exact rollback to `B` or full abandon back to `A`, and any `SUPERSEDED` parent run rejects resume or finalize requests.
2. External manual commits advancing `main` before Sign-Off are detected during `Approve & Merge` and are never overwritten or blindly merged without isolated re-integration and gate verification.
3. Missing Synthesizer credentials in `panel` mode are caught by preflight in `recommend_workflow()` and launch validation, guiding fallback to standard `overnight` mode before any daemon starts.
4. Browser refresh or duplicate click during launch creates at most one idempotent run and restores the active canvas or right-side human-gate drawer from `.baton/guided/session.json`.
5. All Python unit and API tests pass under `unittest`.
6. All Web Studio `vitest` tests and production TypeScript/Vite build pass.

```bash
python -m unittest discover -s tests
npm --prefix web test
npm --prefix web run build
```
