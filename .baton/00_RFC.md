# Master RFC: VibeBaton Stage 2 (`v0.3-canvas`) — React Flow Visual Canvas & Dual-Mode Interactive Demo

## 1. Goal

Upgrade VibeBaton from `v0.2.0` to **`v0.3.0-dev`**: deliver a **3-pane interactive React Flow node-graph canvas** (`web/`), a **zero-config 3-scenario animated Mock Demo** (running both locally via `baton ui` AND purely standalone as static files for GitHub Pages with `base: './'`), **sidebar hot-reload model editing** (`.baton/baton.toml`), and a **Live Run SSE monitor + Start Real Run control**.

---

## 2. Constraints, Pre-Installed Frontend Toolchain & Non-Goals

### Hard Constraints
- **Zero New Python Runtime Dependencies**: Python backend MUST use Python 3.11+ standard library only (`http.server.ThreadingHTTPServer`, `json`, `urllib`, `sqlite3`, `tomllib`, `webbrowser`). Keep `pyproject.toml` `dependencies = []`. Bind default HTTP server to `127.0.0.1`.
- **Pre-Installed Frontend Dependencies (CRITICAL)**:
  - `web/package.json`, `web/package-lock.json`, and `web/node_modules/` are **already installed** on the host and automatically mounted into every worktree via directory junction.
  - **DO NOT run `npm install` or download packages from the internet inside tasks.**
  - Use ONLY the already-installed packages: `react`, `react-dom`, `@xyflow/react`, `lucide-react`, `vite`, `@vitejs/plugin-react`, `typescript`, `vitest` (plus `@types/react`, `@types/react-dom`).
- **Windows Gate Commands**:
  - In PowerShell / Windows `cmd.exe`, always invoke `npm.cmd` and `npx.cmd` (never bare `npm` or `npx` without `.cmd`). Never use `/dev/null`.
  - Standard frontend verification gate: `cd web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build`.
- **100% Backward Compatibility**: Preserve all 11 existing CLI subcommands, all 9 existing MCP tools, and all 63 existing Python tests passing (`python -m unittest discover -s tests -v`).

### Non-Goals (Out of Scope for Stage 2)
- Do **NOT** build Stage 3 Starter View wizard or PNG poster export yet (`v0.9-beta`).
- Do **NOT** modify `web/package.json` or `web/package-lock.json`.

---

## 3. Milestones & Module Deliverables (Contract-First)

### Milestone M1: Python Web Backend Contract & `baton ui` CLI (`critical`)

#### 1. `src/vibebaton/web_server.py`
Zero-dependency `http.server.ThreadingHTTPServer` server hosting both REST/SSE JSON APIs and built static assets (`web/dist/`):
- `create_server(repo_path: Path, host: str = "127.0.0.1", port: int = 7860, static_dir: Path | None = None, config_path: Path | None = None, daemon_spawner: Callable[[Path, Path, str], int] | None = None) -> ThreadingHTTPServer` (alias/wrapper class `VibeBatonWebServer` welcome).
- JSON response helper with `CORS` headers (`Access-Control-Allow-Origin: *` for local Vite dev server compatibility, `OPTIONS` preflight support).
- **Read & Simulation Endpoints**:
  - `GET /api/health`: returns `{"status": "ok", "mode": "local", "version": __version__, "repo": str(repo), "config_path": str(cfg_path), "providers": checks, "quotas": ..., "roles": ...}`
  - `GET /api/presets`: returns `{"presets": [{...PresetSummary.to_dict(), "valid": ..., "errors": [...], "warnings": [...], "graph": WorkflowGraph.to_dict()}]}`
  - `GET /api/presets/{id}`: returns `{"preset": summary, "graph": ..., "validation": ...}` (404 JSON error if unknown ID)
  - `POST /api/graph/validate`: accepts `{"graph": {...}}` or `{"graph_json": "..."}`; returns `{"valid": bool, "errors": [...], "warnings": [...], "entry_nodes": [...], "has_cycles": bool}` (returns `valid: False` with error message on malformed graph without crashing)
  - `POST /api/graph/simulate`: accepts `{"graph": {...} | "preset_id": "...", "scenario": "happy_path"|"gate_retry"|"escalate"}`; validates graph first (400 if invalid or unknown scenario) and returns `{"status": ..., "visited_nodes": [...], "trace": [...]}`
- **Hot-Reload Config Endpoints**:
  - `GET /api/config/roles`: returns `{"config_path": ..., "providers": {name: {"max_concurrency": ..., "command": ...}}, "roles": {name: {"provider": ..., "model": ..., "fallback": [...]}}}`
  - `PUT /api/config/roles/{role_name}`: accepts `{"provider": str (optional), "model": str (required non-empty)}`; validates `role_name` exists and `provider` (if given) exists in `providers` or is `"host_native"`. Ensures repo-local `.baton/baton.toml` exists (copying `baton.example.toml` if config was using package fallback), updates `[roles.<role_name>]` `provider` and `model` cleanly in TOML (preserving all other sections and comments, or cleanly rewriting the TOML key line inside `[roles.<role_name>]`), and verifies reload via `HotReloadConfig`! Returns updated role config.
- **Live Run Monitoring & Control Endpoints**:
  - `GET /api/runs/latest`: returns `{"run": ..., "milestones": [...], "tasks": [...], "events": [...], "quotas": [...]}` (or `{"run": null, "milestones": [], "tasks": [], "events": [], "quotas": []}` if no runs yet)
  - `GET /api/runs/{run_id}`: returns full run snapshot (`run`, `milestones`, `tasks`, `events`, `quotas`; 404 if missing)
  - `GET /api/runs/{run_id}/report`: returns `{"run_id": ..., "battle_report_markdown": generate_battle_report(store, run_id)}` (404 if missing)
  - `GET /api/runs/stream`: `text/event-stream` SSE endpoint (`Cache-Control: no-cache`, `Connection: keep-alive`). Emits `event: snapshot\ndata: <json>\n\n` immediately on connect, and when `?once=1` is present closes cleanly after sending the snapshot (for deterministic automated tests); otherwise polls SQLite every ~1.0s and pushes updated `snapshot` / `event` payloads until client disconnects or server shuts down.
  - `POST /api/runs/start`: accepts `{"rfc_path"?: str, "rfc_markdown"?: str, "mode"?: "overnight"|"interactive", "model_overrides"?: dict[str, str]}`.
    - If `rfc_markdown` is provided, writes safely to `.baton/ui_rfcs/<timestamp>.md`.
    - If `rfc_path` is provided, resolves against `repo_path` and **strictly rejects path traversal outside `repo_path`** (HTTP 400).
    - Creates run in `StateStore`, spawns detached daemon via `daemon_spawner or _spawn_detached_daemon`, logs `daemon_spawned`, returns `201`/`200` `{"run_id": ..., "daemon_pid": ..., "status": "STARTED"}`.
  - `POST /api/runs/{run_id}/control`: accepts `{"action": "pause" | "resume"}` (404 if unknown run; 400 if unsupported action).
  - `POST /api/runs/{run_id}/resolve`: accepts `{"decision": "approve" | "reject", "note"?: str}` and invokes `store.record_human_decision(...)` (+ respawns daemon on `"approve"`).
- **Static Hosting**:
  - Resolves `static_dir` (defaulting to `<package_root>/web/dist` if present).
  - Serves `GET /` -> `index.html`, and static files under `static_dir` with strict path traversal protection (`resolve().is_relative_to(static_dir.resolve())` returning 403/404 on traversal attempts) and proper MIME types (`.html`, `.js`, `.css`, `.svg`, `.json`, `.png`).
  - If `static_dir / "index.html"` does not exist yet, `GET /` returns HTTP 200 helpful HTML notice explaining how to build `web/dist`.

#### 2. `src/vibebaton/cli.py`
- Add `baton ui [--repo .] [--host 127.0.0.1] [--port 7860] [--no-open]`:
  - Prints listening URL `http://{host}:{port}`, opens default browser via `webbrowser.open(...)` unless `--no-open` is passed, and serves until `KeyboardInterrupt` (`Ctrl+C`), shutting down cleanly.
  - Preserve all 11 existing subcommands untouched.

#### 3. `tests/test_web_server.py`
- Pure stdlib `unittest` using `urllib.request` against `create_server(..., port=0)` in a background thread:
  - Tests `/api/health`, `/api/presets`, `/api/presets/flagship_4tier`, 404 on unknown preset, `/api/graph/validate` (valid + unbounded cycle + malformed), `/api/graph/simulate` (all 3 scenarios), `/api/config/roles` + `PUT /api/config/roles/bulk_worker` verifying `.baton/baton.toml` persists & hot-reloads, `/api/runs/start` (with mock `daemon_spawner`) + path traversal rejection, `/api/runs/{id}` + `/report` + `/control` + `/resolve`, `/api/runs/stream?once=1` SSE framing, static file serving + static path traversal rejection, and `cli.build_parser()` accepting `ui --no-open`.

---

### Milestone M2: React Flow Canvas Core & Dual-Mode Offline Engine (`web/`)

1. **Tooling Config**:
   - `web/index.html` (dark background `#090d16`, title `VibeBaton — Multi-Agent Workflow Canvas`)
   - `web/vite.config.ts` (`plugins: [react()]`, `base: './'`, `build: { outDir: 'dist', emptyOutDir: true }`, dev proxy `/api -> http://127.0.0.1:7860`)
   - `web/tsconfig.json` (`strict: true`, `jsx: "react-jsx"`, `moduleResolution: "bundler"`, `noEmit: true`)
   - `web/vitest.config.ts` (`test: { environment: 'node', include: ['src/**/*.test.ts'] }`)
2. **`web/src/types/graph.ts`**:
   - TypeScript definitions for `NodeType` (all 7 atomic types), `WorkflowNode`, `WorkflowEdge`, `WorkflowGraph`, `GraphValidationResult`, `GraphTraceEvent`, `SimulationResult`, `PresetItem`, `RoleConfig`, `LiveRunSnapshot`.
3. **`web/src/data/presets.ts`**:
   - Embedded copies of all 4 official presets (`flagship_4tier`, `solo_coder_3tier`, `starter_2tier`, `review_only_audit`) matching `presets/*.baton.json`, so standalone GitHub Pages / static offline mode works with zero backend.
4. **`web/src/engine/localSimulator.ts` + `web/src/engine/localSimulator.test.ts`**:
   - Pure TypeScript `validateGraph(graph)` and `simulateGraph(graph, scenario)` mirroring `src/vibebaton/graph_schema.py` & `src/vibebaton/graph_engine.py`:
     - Supports all 7 `NodeType`s, bounded-cycle validation (`max_loops >= 1`), entry-node detection ignoring feedback edges, `"happy_path"` (with `merge_node` join semantics), `"gate_retry"`, and `"escalate"` scenarios.
     - Verified with `vitest run` tests covering all 4 embedded presets across all 3 scenarios + unbounded cycle rejection.
5. **`web/src/api/client.ts`**:
   - `BatonApiClient`: auto-probes `GET /api/health` on initialization; exposes `mode: 'local' | 'demo'`.
   - In `local` mode, delegates presets/validate/simulate/roles/runs to the Python backend; in `demo` mode, serves embedded presets & `localSimulator.ts` with zero network errors.
6. **Custom Nodes & React Flow Workspace**:
   - `web/src/components/nodes/BatonNode.tsx`: custom dark-mode React Flow node card rendering all 7 `NodeType`s with distinct tier accent colors & icons (`L0` amber/gold, `L1` violet, `L2` sky/cyan, `L3` emerald, `GATE` indigo/amber, `MERGE` slate, `ROUTER` teal), `model` pill, `max_loops` badge, and animated execution state styles (`idle`, `active`, `passed`, `retrying`, `escalated`, `failed`).
   - `web/src/components/CanvasWorkspace.tsx`: wraps `<ReactFlow>` with custom node registration, `<Background />`, `<Controls />`, `<MiniMap />`, drag-to-move, connect-to-add-edge, node/edge deletion, and dynamic animated edge highlighting for the active/traversed edge during playback or live runs.

---

### Milestone M3: Playback Animation, Model Hot-Swap Inspector, Live Run Panel & Full-Stack Build

1. **`web/src/components/LeftSidebar.tsx`**:
   - **Presets Picker**: cards for all 4 presets (`difficulty` badge, node/edge count, one-click switch).
   - **Node Palette**: all 7 atomic node types — click (or drag) to spawn onto the canvas with sensible defaults.
   - **Import / Export `.baton.json`**: file upload `<input type="file" accept=".json">` validating via `validateGraph` before loading, plus 1-click JSON download.
   - **Graph Validation Pill**: shows `Valid` or exact error/warning list.
2. **`web/src/components/PlaybackBar.tsx`**:
   - Top/bottom floating toolbar for zero-config Mock Demo:
     - Scenario selector (`Happy Path`, `Gate Retry`, `Escalate`)
     - Controls: `Play` / `Pause`, `Step Forward`, `Reset`
     - Speed toggle (`0.5x`, `1x`, `2x`)
     - Progress indicator (`Step X / N`) & current event summary pill.
3. **`web/src/components/RightInspector.tsx`**:
   - **Tab 1 — Node & Edge Inspector**: edit selected node (`label`, `role`, `provider`, `model` e.g. `deepseek-v4.1-flash@max`, `max_loops`) or edge (`sourceHandle`, `targetHandle`, `max_loops`). When connected in `local` mode and the node has a `role`, provides a **"Save to baton.toml (Hot-Reload)"** button calling `PUT /api/config/roles/{role}` with instant feedback toast.
   - **Tab 2 — Trace & Live Run Monitor**:
     - During Mock playback: interactive clickable trace list highlighting nodes/edges.
     - In `local` mode: connects to `EventSource('/api/runs/stream')` to show live run status, task breakdown table, streaming event log, battle report viewer, **"▶ Start Real Run"** modal (enter RFC markdown or repo path + mode `overnight`/`interactive` -> `POST /api/runs/start`), and Pause/Resume/Human Approve/Reject buttons when `WAITING_HUMAN` or `RUNNING`.
4. **`web/src/App.tsx`, `web/src/main.tsx`, `web/src/index.css`**:
   - Cohesive 3-pane layout (`LeftSidebar` + `CanvasWorkspace` with `PlaybackBar` + `RightInspector`), top header with VibeBaton logo, `Local Connected` vs `Standalone Demo` indicator, and responsive design.
   - Note: include `@xyflow/react/dist/style.css` import in `main.tsx` / `App.tsx` so React Flow handles, edges, minimap, and controls render properly!
5. **Full-Stack Integration & Version Bump**:
   - Bump `src/vibebaton/__init__.py` `__version__ = "0.3.0-dev"`.
   - Build `web/dist` (`cd web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build`) and add/verify a Python test in `tests/test_web_server.py` (or `tests/test_web_fullstack.py`) confirming `create_server` serves built `web/dist/index.html` cleanly when `web/dist` exists (and gracefully skips/falls back if absent).

---

## 4. Acceptance Criteria

- [ ] `python -m unittest discover -s tests -v` exits `0` with all 63 existing tests + all new `test_web_server.py` tests passing.
- [ ] `cd web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build` exits `0` and produces `web/dist/index.html`.
- [ ] `python -m vibebaton ui --repo . --no-open --port 0` / server check serves `/api/health`, `/api/presets`, `/api/graph/simulate`, and built static `index.html`.
- [ ] `pyproject.toml` `dependencies == []` (zero Python runtime dependencies added).
- [ ] Built `web/dist/index.html` uses relative asset paths (`./assets/...` via `base: './'`) so it can be opened or deployed to GitHub Pages with zero backend.
