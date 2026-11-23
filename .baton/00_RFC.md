# Master RFC: VibeBaton Stage 4.5 (`v1.0.1`) — Resizable Panes & Task Accordions, 1-Second Live Telemetry Clocks, Interactive Spotlight Tour & Visual Tutorial

## 1. Goal

Deliver the **`v1.0.1`** Studio UX Upgrade across **3 cohesive milestones** on top of the verified `v1.0.0` baseline:
1. **Resizable Dual Sidebars, Adaptive Task Accordion Cards & Backend Live Timing Anchors (`M1`)** — extend `compute_run_telemetry` with `server_now`, stage/model active start anchors, and per-task timing objects; replace the cramped horizontal-scroll 5-column tasks table in `LiveRunPanel.tsx` with full-width collapsible Task Accordion cards; make both Left Sidebar (`220px..440px`) and Right Inspector (`320px..720px`) smoothly resizable via accessible split handles persisted in `localStorage`.
2. **Real-Time 1-Second Live Clocks Across Canvas Nodes, Live Card & Right Inspector Telemetry (`M2`)** — add a single lightweight `useLiveClock` timer (active only for running runs, zero timers on historical runs) synchronized with `telemetry.server_now` so active canvas nodes (`01_PLAN`, active tasks, active milestone reviewers), top-left `Live Run Workflow` card, total elapsed, active stage row, active model runtime + percentage bar, and active task cards all tick up live every second.
3. **Interactive 7-Step Spotlight Guided Tour, Theme-Adaptive Inline SVG Diagrams, Updated Tutorial Doc & `v1.0.1` Release (`M3`)** — build a zero-dependency SVG-mask Spotlight Guided Tour highlighting 7 core controls with click-target progression and bidirectional `EN | 中文` support, add 3 theme-adaptive inline SVG architectural diagrams to `QuickStartModal`'s `Tutorial` / `详细教程` tab plus Mermaid diagrams in `docs/TUTORIAL.md`, and bump release metadata cleanly to `1.0.1`.

---

## 2. Hard Constraints & Invariants (CRITICAL)

- **Zero New Python Runtime Dependencies**: Python backend MUST use Python 3.11+ standard library only (`pyproject.toml` `dependencies = []` unchanged).
- **Pre-Installed Frontend Toolchain (CRITICAL — DO NOT run `npm install`)**:
  - `web/package.json` dependencies and `web/node_modules/` are pre-installed and automatically mounted into every task worktree via junction.
  - **DO NOT** run `npm install`, `pnpm`, `yarn`, or modify `dependencies`/`devDependencies` in `web/package.json`. Use only React 19, TypeScript, Tailwind CSS v4, `@xyflow/react`, `lucide-react`, `vitest`, and existing utilities.
- **Windows Gate Commands**:
  - Never use `/dev/null` in commands; use `os.devnull` in Python or `NUL` on Windows.
  - Always invoke `npm.cmd` and `npx.cmd` on Windows.
  - Python gate: `python -m unittest discover -s tests -v`
  - Frontend gate: `cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"`
- **Orchestration & Testing Hygiene**:
  - Set `reviewer_role: null` on every `critical` task so `Claude Opus` milestone review serves as the quality gate without redundant micro-reviews.
  - Every milestone's `gate_commands` MUST execute full regression tests plus integration tests covering that milestone's modules.
- **UI / i18n / Brand / Secret Hygiene Invariants**:
  - Pure English default UI (`MESSAGES.en` contains ZERO CJK characters) + complete `EN | 中文` parity (`MESSAGES.zh` every leaf string and function return value MUST contain at least one Chinese Han character to satisfy `web/src/i18n/i18n.test.ts`).
  - Never include the substring `"opencode"` anywhere inside `web/src/i18n/messages.ts` (`i18n.test.ts` fails if matched); display **`DeepSeek API`** cleanly in all user-facing copy.
  - Preserve shadcn/ui + Tailwind CSS v4 + React Flow UI (`BaseNode`) Studio design, `web/src/liquid-theme/`, Web Audio controls, and mobile `< 960px` zero-overflow tab layout (`375×667`).
  - Do not commit secrets, stray root scratch files (`CLAUDE.md`, `LOG.md`, `LOG-INDEX.md`), or build artifacts (`web/dist/`).
- **100% Backward Compatibility**:
  - Preserve existing `compute_run_telemetry` keys (`elapsed_sec`, `stages`, `models`, `billing`, optional `conflicts`), exact legacy bytes in `generate_battle_report` (`test_report_without_allocation_events_matches_legacy_bytes`), and all `v1.0.0` entries in `CHANGELOG.md`, `README.md`, and `docs/ROADMAP.md` (`tests/test_release_collateral.py`).

---

## 3. Milestones & Module Deliverables (Contract-First)

### Milestone M1: Live Timing Anchors API, Resizable Dual Sidebars & Adaptive Task Accordions

#### 1. Backend Live Timing Anchors (`src/vibebaton/report.py` & `tests/test_report_telemetry.py`)
Extend `compute_run_telemetry(store, run_id, *, now_ts=None)` strictly additively (keep all existing keys intact):
- Top-level `"server_now": round(now, 3)`.
- Each entry in `telemetry["stages"]` adds:
  - `"started_at": float | None` (epoch seconds when that stage began if currently active, or initial start timestamp)
  - `"is_active": bool` (`True` when stage status is active such as `"PLANNING"`, `"RUNNING"`, `"IN_PROGRESS"`, `"REVIEWING"`, or `"GATE_CHECKING"` while run itself is active; `False` for completed/pending/terminal runs)
- Each entry in `telemetry["models"]` adds:
  - `"active_started_at": float | None` (earliest unpaired `role_invoked.created_at` still in flight while run status is `"PLANNING"` or `"RUNNING"`, else `None`)
- New top-level `"task_timings": dict[str, dict[str, Any]]` mapping each task ID to:
  - `"duration_sec": float` (recorded `task.duration_sec` or fallback sum of completed/elapsed work)
  - `"started_at": float | None` (epoch timestamp of the currently running unpaired invocation when `task.status` is `"RUNNING"`, `"REVIEWING"`, `"GATE_CHECKING"`, or `"COOLDOWN"` and run is active, else `None`)
  - `"is_active": bool`
- Add unit tests in `tests/test_report_telemetry.py` covering active `server_now`, stage `is_active` + `started_at`, model `active_started_at` on unpaired `role_invoked`, per-task `task_timings`, and ensuring finished runs set `is_active=False` and `started_at=None` / `active_started_at=None`.

#### 2. Frontend Resizable Dual Sidebars (`web/src/components/splitPane.ts`, `splitPane.test.ts`, `SplitHandle.tsx`, `web/src/index.css`, `web/src/components/LeftSidebar.css`, `web/src/App.tsx`)
- Create pure helper module `web/src/components/splitPane.ts` (`clampPaneWidth`, `readPaneWidths`, `writePaneWidths`, constants `DEFAULT_SIDEBAR_WIDTH = 288`, `MIN_SIDEBAR_WIDTH = 220`, `MAX_SIDEBAR_WIDTH = 440`, `DEFAULT_INSPECTOR_WIDTH = 376`, `MIN_INSPECTOR_WIDTH = 320`, `MAX_INSPECTOR_WIDTH = 720`, storage key `'vibebaton.paneWidths'`).
- Create `web/src/components/SplitHandle.tsx` (+ CSS styling in `web/src/index.css`): thin interactive `role="separator"` divider (`6px` hit target, subtle `1px` border highlight on hover/drag, `col-resize` cursor) supporting Pointer Events (`setPointerCapture`), ArrowLeft/ArrowRight keyboard steps (`16px`), Home/End clamping, and double-click to reset width cleanly.
- Update `.app` grid in `web/src/index.css`: desktop uses `grid-template-columns: var(--sidebar-w, 288px) 6px minmax(360px, 1fr) 6px var(--inspector-w, 376px)`; update `LeftSidebar.css` from fixed `width: 288px` to `flex: 1 1 auto; width: 100%`; hide `SplitHandle` separators on `< 960px` mobile breakpoint so existing mobile tab switcher (`375×667`) keeps working cleanly.
- Wire persisted widths and `<SplitHandle>` dividers in `web/src/App.tsx` (passing inline CSS variables `--sidebar-w` and `--inspector-w` on `.app`).
- Write thorough unit tests in `web/src/components/splitPane.test.ts`.

#### 3. Adaptive Full-Width Task Accordion Cards (`web/src/components/inspector/LiveRunPanel.tsx`, `web/src/components/RightInspector.css`)
- Replace the rigid 5-column HTML `<table>` inside `LiveRunPanel.tsx` with a responsive vertical **Task Accordion Card list** (`grid min-w-0 grid-cols-1 gap-2`):
  - **Collapsed header button (`aria-expanded={isExpanded}`, `w-full min-w-0`)**:
    - Top line: Chevron icon + monospace `task.id` + localized status `<Badge>` + task live/completed duration chip on the right;
    - Second line: wrapping task title (natural line wrap, zero horizontal clipping) + tier & localized role metadata pills.
  - **Expanded panel** (renders cleanly directly inside the card at `100%` of the inspector's current width — no 5-column `colSpan` table overflow!):
    - Assigned model (using `DeepSeek API` display), live/final duration, counters (`self_heal`, `review_reject`, `escalated`), allowed file pills, `last_error` pre-wrap block, and filtered task audit events.
  - Zero horizontal scrollbar needed at default `376px` width AND expands gracefully as the user widens the right inspector up to `720px`!

---

### Milestone M2: Real-Time 1-Second Live Clocks Across Canvas Nodes & Sidebar Telemetry

#### 1. Types & Shared Clock Engine (`web/src/types/graph.ts`, `web/src/engine/liveClock.ts`, `web/src/engine/liveClock.test.ts`)
- Extend `web/src/types/graph.ts`:
  - Export `TaskTiming { duration_sec: number; started_at: number | null; is_active: boolean }`.
  - Add optional `started_at?: number | null`, `is_active?: boolean` on `StageTelemetry`.
  - Add optional `active_started_at?: number | null` on `ModelTelemetry`.
  - Add optional `server_now?: number`, `task_timings?: Record<string, TaskTiming>` on `RunTelemetry`.
- Create `web/src/engine/liveClock.ts` with pure testable functions and React hook:
  - `isRunStatusActive(status: unknown): boolean` (`PLANNING`, `RUNNING`, `IN_PROGRESS`, `REVIEWING`, `GATE_CHECKING`).
  - `computeLiveSeconds(baseSec: number, startedAt: number | null | undefined, isActive: boolean | undefined, nowEpochSec: number): number` — returns `baseSec` untouched when inactive or `startedAt` is null/non-finite; otherwise adds `Math.max(0, nowEpochSec - startedAt)`.
  - `computeClockSkewSec(serverNow: number | null | undefined, clientNowSec?: number): number` — adjusts local clock safely when `server_now` is provided.
  - `useLiveClock(active: boolean, serverNow?: number | null): number` — returns current adjusted epoch seconds, ticking every `1000ms` ONLY while `active === true`, cleaning up interval cleanly on unmount or when run finishes.
- Add comprehensive tests in `web/src/engine/liveClock.test.ts`.

#### 2. Live Timing Badges on Canvas Nodes (`web/src/components/nodes/BatonNode.tsx`, `BatonNode.css`, `web/src/engine/flowAdapter.ts`, `web/src/engine/liveRunGraph.ts`, `liveRunGraph.test.ts`)
- Extend `BatonNodeData` and `WorkflowNode['config']` handling cleanly with optional runtime metadata (`duration_sec?: number`, `started_at?: number | null`, `is_timing_active?: boolean`).
- Update `buildLiveRunGraph(snapshot, locale, nowEpochSec?)` in `web/src/engine/liveRunGraph.ts` to populate each node's `config` with timing telemetry from `snapshot.telemetry` (`PLANNING` stage for `live-planner`, `task_timings[taskId]` for `live-task-*`, milestone `stages` entry for `live-ms-*`).
- In `BatonNode.tsx` (+ `BatonNode.css`): when node `duration_sec !== undefined` (or active `is_timing_active`), render a crisp monospace timing pill inside `<BaseNodeContent>` (`● 4m 18s` / `● 4分18秒` with subtle emerald/cyan pulse while active; steady `⏱ 11m 06s` when finished). Pass live `nowEpochSec` down cleanly from `App.tsx` (updating `node.data` smoothly WITHOUT remounting React Flow or interrupting pan/zoom!) so canvas node timers tick live every second without flicker.
- A timing-only snapshot refresh preserves the current canvas layout and selection. Apply timing by node ID to the rendered nodes. The saved and shared recipe contains the user-edited positions and workflow configuration.
- Add unit tests in `web/src/engine/liveRunGraph.test.ts` verifying active vs completed node timings.

#### 3. Wire Live Clocks into Left Sidebar & Right Inspector (`web/src/App.tsx`, `web/src/components/LeftSidebar.tsx`, `web/src/components/RightInspector.tsx`, `web/src/components/inspector/LiveRunPanel.tsx`)
- Compute `liveNowSec` via `useLiveClock(isSelectedRunActive, liveSnapshot?.telemetry?.server_now)` cleanly in `App.tsx` (and pass `liveNowSec` down to `LeftSidebar`, `LiveRunPanel`, and live canvas nodes).
- Update:
  - `LeftSidebar.tsx`: Live Run card header elapsed time ticks live using `computeLiveSeconds` while the displayed run is active.
  - `LiveRunPanel.tsx`:
    - Header `Total: ...` / `总耗时：...` computes live total elapsed when active.
    - Every Stage Timing row uses `computeLiveSeconds(stage.wall_sec, stage.started_at, stage.is_active, liveNowSec)` and renders a subtle live pulse dot on active stages.
    - Every Model Runtime row uses `computeLiveSeconds(item.duration_sec, item.active_started_at, Boolean(item.active_started_at), liveNowSec)` and recalculates live percentage bar shares cleanly (`share_pct`) across the updated model durations!
    - Every Task Accordion row & expanded detail view displays live `task_timings[taskId]` elapsed seconds when active.
- Ensure historical runs (`COMPLETED`, `READY_FOR_FINAL_GATE`, `FAILED`, `HALTED`) keep static exact durations and trigger ZERO 1-second timer updates!

---

### Milestone M3: Interactive Spotlight Guided Tour, Visual SVG Diagrams Tutorial, Doc Diagram Upgrade & `v1.0.1` Release

#### 1. Semantic Tour Anchors & Pure-Stdlib Spotlight Guided Tour (`web/src/components/tour/tourSteps.ts`, `tourSteps.test.ts`, `GuidedTourOverlay.tsx`, `GuidedTourOverlay.css`)
- Add non-invasive `data-tour-id` attributes on the 7 core regions across existing components (`HeaderBar`, `LeftSidebar`, `CanvasWorkspace`, `RightInspector`, `LiveRunPanel`):
  1. `live-run-card` (LeftSidebar Live Run Workflow card — switches conditionally if present, else gracefully skips or highlights first preset)
  2. `budget-profile` (LeftSidebar Budget Profile selector)
  3. `recipe-plaza` (LeftSidebar Recipe Plaza filters & presets)
  4. `canvas-workspace` (Center Canvas & PlaybackBar controls)
  5. `inspector-live-tab` (RightInspector `Trace & Live Run` tab button)
  6. `start-real-run-btn` (LiveRunPanel `▶ Start Real Run` button — only shown when `mode === 'local'`, otherwise gracefully falls back or omits local-only steps cleanly in demo!)
  7. `header-controls` (HeaderBar language `EN | 中文`, theme reveal, audio & guide trigger)
- Create pure testable `web/src/components/tour/tourSteps.ts` (`resolveAvailableTourSteps(mode, hasLiveRun, hasElement)`) so steps dynamically handle `local` vs `demo` mode and whether a live run exists, and automatically instruct which UI tab/pane should be activated on each step (`requiredPane`, `requiredInspectorTab`).
- Create `web/src/components/tour/GuidedTourOverlay.tsx` + `GuidedTourOverlay.css`:
  - Renders a full-screen portal SVG spotlight mask punching a rounded cutout around the target element's `getBoundingClientRect()` (auto-tracked on resize/scroll/`ResizeObserver`).
  - Places a high-contrast floating popover card adjacent to the spotlight cutout with automatic viewport edge-flipping so it is never clipped at top/bottom/left/right or on mobile `375×667`.
  - Includes clickable interactive progression: clicking the highlighted target area itself (or clicking `Next` / `下一步`) advances to the next step; also provides `Back`, `Skip`, `Finish`, step progress indicator (`1 / 7`), and `Escape` key dismissal.
- Connect `onStartTour()` from `QuickStartModal.tsx` -> `App.tsx` (closing the modal and launching step 1 cleanly!).

#### 2. Visual Inline SVG Diagrams inside QuickStart Tutorial & Mermaid Diagrams in Docs (`web/src/components/tutorial/TutorialDiagrams.tsx`, `web/src/components/QuickStartModal.tsx`, `docs/TUTORIAL.md`)
- Create `web/src/components/tutorial/TutorialDiagrams.tsx` exporting 3 crisp, theme-adaptive (`var(--card)`, `var(--border)`, `var(--primary)`, `var(--emerald)`, `var(--amber)`) localized inline `<svg>` diagrams (`viewBox` responsive, `aria-label` accessible, zero external images/network requests):
  1. **Diagram 1 (Chapter 1 — 4-Tier Relay Pipeline)**: visual flow showing `L0 (User)` -> `L1 Planner` -> `L3 DeepSeek API Workers` -> `Mechanical Gate` -> `L2 Reviewer` -> `L0 Final Merge`.
  2. **Diagram 2 (Chapter 2 — Safe 5-Step Guided Flow & Live Sync)**: visual diagram linking `Budget + Recipe` -> `3-Step Wizard + Security Guards` -> `Live Run Card <-> Canvas Sync` -> `Bilingual Report + L0 Sign-Off`.
  3. **Diagram 3 (Chapter 3 — Git Worktree Sandbox & Physical Whitelist Guard)**: visual diagram contrasting isolated parallel `.baton/worktrees/` + whitelist revert against protected `main` branch.
- Embed these diagrams cleanly in `QuickStartModal.tsx` inside the `Tutorial` / `详细教程` tab cards AND add a prominent **"Start 1-Minute Interactive Tour"** / **「🎯 开始 1 分钟交互式导览」** CTA banner at the top of `QuickStartModal` (plus inside the `Tutorial` tab).
- Update `docs/TUTORIAL.md` to include matching Mermaid diagrams (`flowchart LR`) for the 4-tier relay and isolated worktree protection alongside the existing beginner walkthrough.

#### 3. Pure Bilingual i18n, Manifests `1.0.1` Bump & Release Verification
- Add all new pure EN and pure ZH labels to `web/src/i18n/messages.ts` for:
  - Resizable handle `aria-label` / tooltip / double-click reset hint
  - Live clock status badge (`LIVE` / `实时计时`)
  - Interactive Spotlight Tour (`startTourButton`, `tourStepProgress`, `next`, `prev`, `finish`, `skip`, and all 7 step titles/descriptions/click hints)
  - SVG diagram captions & accessibility labels
  - Enforce `i18n.test.ts` strictly: zero CJK in EN, Han character in every leaf of ZH, zero `"opencode"` substring anywhere in `messages.ts`.
- Bump version string `"1.0.0"` -> `"1.0.1"` across:
  - `pyproject.toml`, `src/vibebaton/__init__.py`, `web/package.json`
  - Append `## [v1.0.1] - 2026-11-22` section to `CHANGELOG.md` (keeping all prior headings `[v0.1-seed]`, `[v0.2.0]`, `[v0.3.0]`, `[v0.9.0-beta]`, `[v1.0.0]` intact so `tests/test_release_collateral.py` passes cleanly!)
  - Update `tests/test_version_consistency.py` (`RELEASE_VERSION = "1.0.1"`) and `tests/test_web_fullstack.py` (check `"/api/health"["version"] == __version__` or `"1.0.1"` so tests match `1.0.1`).
  - Also update `docs/ROADMAP.md` (`v1.0.0` marked merged `ecab208`, `v1.0.1` Stage 4.5 documented).
- Run both final gates and make sure everything passes cleanly:

```bash
python -m unittest discover -s tests -v
```

```bash
cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"
```

---

## 4. Non-Goals

- Do not alter core task scheduling, model allocation algorithms, HTTP transport, or Git conflict resolution behavior from `v1.0.0`.
- Do not install new npm packages or Python third-party packages.
- Do not modify `main` directly during unattended execution or commit real API keys/runtime `.baton/state.sqlite*` files.

---

## 5. Acceptance Criteria

1. `compute_run_telemetry` exposes `server_now`, stage/model live start anchors, and `task_timings` while preserving 100% compatibility with existing `test_report_billing.py`, `test_report_telemetry.py`, and `test_web_fullstack.py`; desktop Left Sidebar (`220px..440px`) and Right Inspector (`320px..720px`) resize cleanly with `localStorage` persistence; Task Accordion cards expand at full inspector width without horizontal scrolling.
2. Live active runs (`PLANNING`/`RUNNING`) tick elapsed time smoothly once per second across active canvas nodes (`BatonNode`), top-left `Live Run Workflow` card, total elapsed, active stages, active models + share bars, and active task cards, while historical completed runs remain static with zero active timers.
3. `QuickStartModal` includes 3 theme-adaptive inline SVG diagrams and launches an interactive 7-step Spotlight Guided Tour (`GuidedTourOverlay`) in both pure EN and `中文`; manifests report `1.0.1`; both verification commands below pass cleanly with exit code `0`:

```bash
python -m unittest discover -s tests -v
```

```bash
cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"
```
