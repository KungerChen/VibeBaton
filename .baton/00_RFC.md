# Master RFC: Stage 6 (v1.2.0) — Guided End-to-End Studio Experience, Universal CLI Registry & 220+ Bilingual Tech Glossary

## Goals

Transform VibeBaton Studio from a developer-only workflow monitor into an **empowering, single-window end-to-end orchestration workbench** with **`引导模式` (`Guided`)** and **`专业模式` (`Pro`)** modes, while keeping zero third-party Python dependencies and preserving 100% compatibility with all existing CLI commands and Pro Studio features:

1. **Universal AI CLI Driver Registry & Authorized One-Click Discovery/Install (`cli_registry.py`, `presets/cli_registry.json`, `credentials.py`, `web_server.py`)**:
   - Ship a bundled driver registry of **8+ mainstream AI coding CLIs** (`claude`, `codex`, `dsh`, `gemini`, `opencode`, `aider`, `qwen`, `copilot`), each carrying structured metadata (`id`, `name`, `tier` = `"official"` | `"community"`, `binary`, `summary_en`, `summary_zh`, `prereq`, `install_cmd`, `login_cmd`, `official_url`, `command_template`).
   - Support authorized local host scanning (`POST /api/cli-registry/scan`), fixing false-negative readiness checks such as `dsh_opencode` when `dsh` already executes cleanly via its local config without `OPENCODE_API_KEY` set in env, explicit user-confirmed allowlisted installs (`POST /api/cli-registry/install`), login launch (`POST /api/cli-registry/login`), and optional registry sync.
   - Automatically synthesize a **Ready-on-Host Lineup** even when a user only has **one** working CLI or **one** HTTP API key, so users never hit a wall of red missing-provider badges.

2. **Single-Window 4-Step Guided Closed Loop (`brainstorm.py`, `web_server.py`, `web/src/components/guided/`)**:
   - **Mode Switcher (`引导模式 / 专业模式`, `Guided / Pro`)** in the header persisted cleanly in `localStorage` (while keeping Pro mode as default-compatible so all existing Pro workflows and tests stay green).
   - **Step 1 — Workspace & Toolkit (`GuidedSetupStep`)**: Pick project folder (`/api/workspace/info`, `/api/workspace/select`), inspect/one-click initialize Git (`/api/workspace/init-git`), run authorized CLI scan/install/login, and auto-select a valid lineup.
   - **Step 2 — In-App Architecture Brainstorm & Blueprint Confirmation (`GuidedBrainstormStep`, `brainstorm.py`)**: Starter scenario cards + multi-turn plain-language conversation (`/api/brainstorm/chat`) that compiles `.baton/00_RFC.md` behind the scenes and presents an approachable **Blueprint Card** (`summary`, `deliverables`, `touched_areas`, `verification_plan`, `readiness_score`) for one-click launch (`/api/brainstorm/confirm`) — without ever leaving the Studio window or exposing raw schema jargon unless expanded.
   - **Step 3 — Animated Live Workbench, Node Detail Drawer & Plain-Language Decisions (`NodeDetailDrawer`, `GuidedDecisionModal`)**: Click any live or completed DAG node to inspect a plain-language summary, active model, elapsed runtime, billed cost, test status, and changed files via `GET /api/runs/<id>/tasks/<task_id>`. When `WAITING_HUMAN` occurs, present clear choice cards inside Studio (`POST /api/runs/<id>/resolve`).
   - **Step 4 — In-App Sign-Off & One-Click Time-Machine Rollback (`GuidedSignOffPanel`)**: Display test pass summary, changed files, Battle Report preview, **"验收通过，应用改动" / "Approve & Apply Changes"**, **"提出修改意见" / "Request Revisions"**, and **"一键回退至开工前快照" / "Restore Pre-Run Snapshot"** backed by `baton-backup/<run_id>` tags via `POST /api/runs/<id>/finalize`.

3. **220+ Term Empowering Bilingual Tech Glossary (`web/src/data/glossary.ts`, `GlossaryTerm.tsx`, `GlossaryDrawer.tsx`)**:
   - Ship **at least 220 curated `EN | 中文` entries** spanning 6 categories (`vibebaton`, `git`, `ai`, `engineering`, `web_http`, `errors`). Every entry has `oneLiner`, `plainExplain` (`通俗解读` / `Plain Explanation`), `proExplain` (`技术定义` / `Technical Definition`), and `related` IDs.
   - Provide subtle first-occurrence dotted term highlights (`<GlossaryTerm>`) inside Guided Mode copy plus a persistent searchable **`术语速查词典` / `Tech Glossary`** drawer accessible anytime.
   - **Respectful, Empowering Copy Rule**: ZERO condescending labels (`/小白|菜鸟|傻瓜|笨蛋|noob|dummy/i`) anywhere in UI strings, Guided prompts, or Glossary content. Tone treats every user as the Lead Architect commanding an engineering relay studio.

4. **Publish `v1.2.0` Release & Verified Documentation**:
   - Bump versions cleanly to `1.2.0` across manifests, update `CHANGELOG.md`, `docs/ROADMAP.md`, `docs/TUTORIAL.md`, `README.md`, and `README.zh-CN.md`, and keep all frontend and backend test suites green.

## Constraints

- **Zero new Python runtime dependencies**: `cli_registry.py`, `brainstorm.py`, `credentials.py`, `web_server.py`, and all modules in `src/vibebaton/` must use Python 3.11+ standard library modules only.
- **Zero new npm dependencies**: Do NOT run `npm install` or modify `web/package-lock.json`; only bump `"version": "1.2.0"` in `web/package.json`. On Windows, invoke frontend tools via `npx.cmd` and `npm.cmd`.
- **Safe CLI Installation & Workspace Boundaries**:
  - `POST /api/cli-registry/install` MUST ONLY execute commands strictly matching allowlisted recipes from the trusted CLI registry (or explicitly confirmed user consent flag), never arbitrary shell strings from client requests.
  - `POST /api/workspace/select` / `/init-git` / `/finalize` must validate resolved directory paths cleanly and create a lightweight `baton-backup/<run_id>` Git tag on `main` (or base branch) before applying `dev` changes so `rollback` is deterministic and reversible.
  - Preexisting `credentials.py` security invariants remain intact (never store plaintext keys inside `.git` repo directories).
- **Backward Compatibility & Anti-Condescension Invariants**:
  - Existing CLI subcommands (`init`, `doctor`, `run`, `status`, `report`, `ui --app`, `sandbox init`, `export-case`, `mcp`, `presets`, `promote-seed`) and all existing `Pro` Studio workflows, 8 workflow presets, and `test_web_server.py` / `test_web_fullstack.py` / `test_desktop_app.py` / `test_release_collateral.py` contracts must stay 100% green.
  - Maintain pure English in `MESSAGES.en` (zero CJK), >= 1 Han char per leaf in `MESSAGES.zh` (`QUICK_START_IDENTIFIERS` exempted), `"DSH"` display naming, zero `/opencode/i` in UI display strings (NOTE: use `"DSH / OpenCode Go"` rule carefully — e.g., when displaying CLI driver IDs from the dynamic `/api/cli-registry` data model vs static `MESSAGES` keys, keep static `MESSAGES` strings completely compliant with `i18n.test.ts`!).
  - Strict anti-condescension guard across `web/src/i18n/messages.ts`, `web/src/data/glossary.ts`, and `src/vibebaton/brainstorm.py`: zero matches against `/小白|菜鸟|傻瓜|笨蛋|noob|dummy/i`.
- **Execution Planning Note (`allowed_paths`)**: Ensure EVERY task in `M1`–`M3` includes any companion `.test.ts` / `.test.py` files that enforce exhaustive union types, message keys, preset counts, or version numbers in its `allowed_paths`.

## Non-Goals

- Do NOT attempt automated browser password entry or CAPTCHA solving for OAuth CLI logins (always launch official `login_cmd` interactively or guide user clearly).
- Do NOT break headless/scripted `baton run` usage or require interactive Studio input when running CLI commands.
- Do NOT auto-execute arbitrary untrusted shell install commands from unvalidated remote URLs without allowlist verification.

## Architecture & Deliverables (Milestones M1–M3)

### M1: Universal CLI Registry, Guided Workspace/Brainstorm/Finalize APIs & Backend Tests

- **`presets/cli_registry.json` & `src/vibebaton/cli_registry.py`**:
  - Curate 8+ CLI driver entries (`claude`, `codex`, `dsh`, `gemini`, `opencode`, `aider`, `qwen`, `copilot`) covering official multi-file CLIs and community coding tools, including prerequisites, official install commands, login commands, homepage URLs, and command/parser integration tiers.
  - Implement `load_cli_registry()`, `scan_host_clis(repo_path, cfg, credentials_path)` (checking prerequisite runtimes like `node`, `python`, `git`, binary discovery via `resolve_cli_binary`, auth/version checks, and fixing `dsh_opencode` false negatives when `dsh` already has working local profile config without requiring `OPENCODE_API_KEY` env var unless unconfigured), `run_cli_install(cli_id, confirmed=True, ...)` (allowlist-enforced), and `launch_cli_login(cli_id, ...)`.
  - Include `build_recommended_lineup(scan_result, cfg)` so even a single ready CLI or single HTTP API key returns a valid single-click runnable configuration without missing-provider dead ends.
- **`src/vibebaton/brainstorm.py`**:
  - Pure-stdlib `brainstorm_turn(repo_path, messages, scenario=None, cfg=None)` supporting live dispatch via the best ready provider (plus offline/deterministic fallback when running tests or offline tour), outputting assistant reply, updated `.baton/00_RFC.md` draft, and structured Blueprint Card (`title`, `summary`, `deliverables`, `touched_areas`, `verification_plan`, `readiness_score`, `ready_to_launch`), plus `confirm_blueprint(repo_path, rfc_markdown, cfg)` writing `.baton/00_RFC.md` cleanly and running `check_rfc_readiness`.
- **`src/vibebaton/web_server.py` & Backend Tests (`tests/test_cli_registry.py`, `tests/test_guided_api.py`)**:
  - Wire REST endpoints cleanly into `VibeBatonWebServer`:
    - `GET /api/cli-registry` (catalog + tags)
    - `POST /api/cli-registry/scan` (authorized host scan + recommended lineup)
    - `POST /api/cli-registry/install` (confirmed allowlisted install)
    - `POST /api/cli-registry/login` (launch official CLI auth flow)
    - `GET /api/workspace/info`, `POST /api/workspace/select`, `POST /api/workspace/init-git`
    - `POST /api/brainstorm/chat`, `POST /api/brainstorm/confirm`
    - `GET /api/runs/<id>/tasks/<task_id>` (human-readable node detail payload: summary, model, elapsed_sec, cost_usd, changed_files, review_verdict)
    - `POST /api/runs/<id>/resolve` (in-app `WAITING_HUMAN` decision submission & daemon resume trigger)
    - `POST /api/runs/<id>/finalize` (`action = "approve" | "revise" | "rollback"`, tagging `baton-backup/<run_id>` on base branch before merge and restoring cleanly on rollback).
  - Add thorough mocked unit & HTTP integration tests in `tests/test_cli_registry.py` and `tests/test_guided_api.py`, updating `tests/test_web_server.py` and `src/vibebaton/credentials.py` as needed.

### M2: 220+ Bilingual Glossary, Guided Mode 4-Step Flow & Pro Mode Integration

- **`web/src/data/glossary.ts` & `web/src/data/glossary.test.ts`**:
  - Create **>= 220 structured `GlossaryEntry` records** spanning 6 categories (`vibebaton`, `git`, `ai`, `engineering`, `web_http`, `errors`) with fields `id`, `term`, `category`, `oneLiner_en`, `oneLiner_zh`, `plainExplain_en`, `plainExplain_zh`, `proExplain_en`, `proExplain_zh`, `related`.
  - Add `web/src/data/glossary.test.ts` validating count `>= 220`, non-empty EN/ZH fields, valid `related` links, and zero matches for condescending terms (`/小白|菜鸟|傻瓜|笨蛋|noob|dummy/i`).
- **`web/src/components/GlossaryTerm.tsx` & `web/src/components/GlossaryDrawer.tsx`**:
  - Implement `<GlossaryTerm>` interactive inline term popover (plain explanation + technical definition + clickable related terms) with a helper avoiding duplicate underlines inside a single paragraph, plus top-bar searchable **`术语速查词典` / `Glossary`** drawer.
- **Studio Guided Mode vs Pro Mode (`web/src/components/guided/*`, `App.tsx`, `HeaderBar.tsx`, `client.ts`, `messages.ts`, `i18n.test.ts`, `types/graph.ts`, `graph.test.ts`)**:
  - Add header **`引导模式` (`Guided`) / `专业模式` (`Pro`)** switcher, persisting user preference in `localStorage`. Existing Pro views remain untouched when in Pro mode.
  - Build the 4-step empowering Guided Closed Loop:
    1. `GuidedSetupStep.tsx`: Visual project folder picker + Git status check/one-click init + authorized Universal CLI Registry scan/install/login + auto-ready lineup card.
    2. `GuidedBrainstormStep.tsx`: Scenario starter cards + conversational multi-turn brainstorming UI + clear Blueprint Card + **"确认蓝图，开始编排"** action.
    3. `NodeDetailDrawer.tsx` & `GuidedDecisionModal.tsx`: Clicking any canvas node opens `NodeDetailDrawer` showing plain summary, model, runtime, cost, files touched, and check results; `WAITING_HUMAN` pauses surface inside `GuidedDecisionModal` with clear option cards.
    4. `GuidedSignOffPanel.tsx`: Final verification card showing passing tests, modified files summary, Battle Report link, **"验收通过，应用改动"**, **"提出修改意见"**, and **"一键回退至开工前快照"**.
  - Update `web/src/i18n/messages.ts` with complete `EN | 中文` parity (zero `/opencode/i` and zero condescending wording), add component unit tests, and run full `npx.cmd vitest run && npx.cmd tsc --noEmit`.

### M3: Version `1.2.0`, Release Documentation & Full Verification

- **Version Bump (`1.2.0`)**:
  - Update `pyproject.toml`, `src/vibebaton/__init__.py`, `web/package.json`, and `tests/test_version_consistency.py` to `1.2.0` (do NOT modify `web/package-lock.json`).
- **Release Collateral (`CHANGELOG.md`, `docs/ROADMAP.md`, `docs/TUTORIAL.md`, `README.md`, `README.zh-CN.md`)**:
  - Append `## [v1.2.0] - 2026-11-24` to `CHANGELOG.md` (preserving oldest-first order).
  - Document Stage 6 Guided Mode, Universal CLI Registry, and 220+ Tech Glossary across `docs/ROADMAP.md`, `docs/TUTORIAL.md`, `README.md`, and `README.zh-CN.md` (preserving existing `1.0.0`, `sandbox init`, `scripts/install.ps1`, 16 FPS GIFs, and `--app` launcher sections).
- **Full-Stack Final Gate**:
  - Run frontend `vitest run`, `tsc --noEmit`, `vite build` AND full backend `unittest discover -s tests -v`, `presets --validate`, `--version`, and `test_release_collateral.py`.

## Verification & Acceptance Criteria

Run all verification checks sequentially without shell races:

```bash
cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"
cmd /c "set PYTHONPATH=src&& set PYTHONUTF8=1&& set VIBEBATON_DISABLE_PRICING_SYNC=1&& python -m unittest discover -s tests -v"
```

1. `tests/test_cli_registry.py` and `tests/test_guided_api.py` pass all unit & HTTP integration tests covering 8+ CLI drivers, authorized scan (`dsh` false-negative fix included), allowlist install safety, workspace Git init, multi-turn brainstorm -> Blueprint Card + RFC confirmation, task detail lookup, in-app resolve, and finalize/rollback tags.
2. `web/src/data/glossary.test.ts` passes with **`>= 220` terms** across 6 categories, 100% EN/ZH parity, valid `related` graph, and zero condescending terms across glossary + UI copy.
3. Guided Mode 4-step components (`GuidedSetupStep`, `GuidedBrainstormStep`, `NodeDetailDrawer`, `GuidedDecisionModal`, `GuidedSignOffPanel`, `GlossaryDrawer`, Mode Switcher) pass TypeScript & Vitest tests without regressing any Pro mode functionality (`web/src/` tests & `tests/test_web_fullstack.py` green).
4. `python -m vibebaton --version` prints `vibebaton 1.2.0`, `python -m vibebaton presets --validate` passes all presets (`errors=0, warnings=0`), and `tests/test_version_consistency.py` + `tests/test_release_collateral.py` + `tests/test_desktop_app.py` pass cleanly.
5. `npx.cmd vitest run`, `npx.cmd tsc --noEmit`, `npm.cmd run build`, and `python -m unittest discover -s tests -v` exit `0` with `0` failures.
