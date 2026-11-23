# Master RFC: Stage 4.8 (v1.0.4) — Intuitive Recipe Backup/Share, Sanitized Run Case Export (.baton-case.json) & Universal Case Replay Player

## Goals

Make workflow sharing intuitive and transform VibeBaton into a shareable, privacy-safe replay player for real multi-agent development runs:

1. **Intuitive Recipe Backup & Share UX (`LeftSidebar`, `RecipeTransferModals`)**:
   - Replace bare technical `Import .baton.json / Export JSON / Share Link` buttons with clear plain-language **Save, Import & Share** action cards that explain what `.baton.json` contains (workflow graph & model routing only — zero source code or API keys) and show rich preview confirmation dialogs before overwriting the canvas or downloading files.

2. **Sanitized Run Case Export (`case_export.py`, `baton export-case`, `GET /api/runs/{id}/case-export`)**:
   - Allow users to export any completed or historical VibeBaton run into a portable `.baton-case.json` bundle (`schema_version = "baton-case/v1"`) combining the sanitized DAG `graph`, chronological `GraphTraceEvent[]` `trace`, summary metrics `meta`, and a transparent `redaction_report`.
   - Enforce a deterministic **4-layer redaction firewall** (API keys/credentials, host paths/usernames, private emails/RFC1918 IPs, raw code diffs/stack traces/RFC source text) and verify cleanliness before returning or saving.

3. **Universal Case Replay Bar (`PlaybackBar`, `caseReplay.ts`) Using Stage 1 as Built-in Tutorial**:
   - Upgrade the top-center `Stage 1 60×` toggle into a universal **Case Replay Player**:
     - Default built-in tutorial case is **Tutorial: Stage 1 (60×)** wrapping the existing Stage 1 self-hosting trace so first-time users can watch an example and learn how case import/export works.
     - Once a user imports any `.baton-case.json` case (or previews an exported run case), the top replay slot dynamically updates to **`Start Replay: <Case Title>`** so anyone can play back another user's real iteration flow (with speed control, step-forward, reset, live telemetry commentary, and a switcher back to Stage 1).

4. **Publish `v1.0.4` Release & Pre-1.0 Version Bridge Documentation**:
   - Update release manifests cleanly to `1.0.4`, document the `.baton-json` vs `.baton-case.json` tutorial flow in `docs/TUTORIAL.md`, add the concise clarifying note under `## [v0.9.0-beta]` in `CHANGELOG.md` explaining the `0.3` to `0.9` pre-1.0 feature-complete beta jump, and keep all tests passing with complete `EN | 中文` parity.

## Constraints

- **Zero new Python runtime dependencies**: `case_export.py`, `cli.py`, and `web_server.py` must use Python 3.11+ standard library modules only (`json`, `re`, `os`, `time`, `uuid`, `pathlib`, `dataclasses`, `ipaddress`).
- **Zero new npm dependencies**: Do NOT run `npm install` or edit `package-lock.json`; only bump `"version": "1.0.4"` in `web/package.json`. On Windows, invoke `npx.cmd` and `npm.cmd`.
- **Privacy & Security Guarantees**:
  - Case export MUST scrub credential strings (`sk-*`, `ghp_*`, `github_pat_*`, `AIza*`, `Bearer <token>`, secret webhook URLs, and configured values from `credentials.py` when present), host user/repo directories (`C:\Users\<user>`, `/Users/<user>`, `/home/<user>`, `repo_path`), email addresses, private IPs (`10.*`, `172.16-31.*`, `192.168.*`), raw diffs, and raw stack traces.
  - Exported `graph` MUST satisfy both Python `graph_schema.validate_graph` and TypeScript `localSimulator.validateGraph` (`schema_version: "1.0"`, valid node/edge IDs and handles).
- **Backward Compatibility & UI Invariants**:
  - Keep existing `STAGE1_REPLAY_TRACE` / `stage1Replay.test.ts` contracts, `#recipe=` share links (`shareUrl.ts`), `SplitHandle`, `liveClock`, `GuidedTourOverlay`, `AttentionBanner`, and `PricingModal` intact and unbroken.
  - Maintain pure English default locale (zero CJK in `MESSAGES.en`), Han characters in `MESSAGES.zh`, `"DSH"` display name consistently, and zero `/opencode/i` in UI copy (`web/src/i18n/i18n.test.ts`).
  - Keep `tests/test_release_collateral.py` invariants intact and list `CHANGELOG.md` versions oldest-first (`v1.0.4` appended after `v1.0.3`, zero HTML comments).

## Non-Goals

- Do NOT host a remote cloud gallery server or upload user runs automatically to any third-party service.
- Do NOT auto-execute imported `.baton-case.json` files or run real agents during replay (replay is strictly local, visual, and read-only).
- Do NOT alter historical records in `state.sqlite` when exporting a case.

## Architecture & Deliverables (Milestones M1–M3)

### M1: Backend Sanitized Case Export (`case_export.py`), CLI & REST API

- **`src/vibebaton/case_export.py`**:
  - Define `@dataclass class RedactionReport` (`secrets_redacted: int`, `paths_anonymized: int`, `emails_redacted: int`, `ips_redacted: int`, `raw_diff_stripped: int`, `raw_stack_stripped: int`, `clean: bool`) and `export_sanitized_case(store, run_id, *, title=None, include_review_summaries=True, anonymize_run_id=False, extra_secrets=None) -> dict[str, Any]`.
  - **4-Layer Sanitization Firewall**:
    1. **Layer 1 (Secrets)**: redact `sk-[A-Za-z0-9_-]{12,}`, `ghp_[A-Za-z0-9]{16,}`, `github_pat_[A-Za-z0-9_]{20,}`, `AIza[A-Za-z0-9_-]{20,}`, `Bearer <token>`, `xoxb-` / `xapp-` tokens, webhook URL secret tokens/queries (`open.feishu.cn/open-apis/bot/v2/hook/...`, `hooks.slack.com/services/...`, `discord.com/api/webhooks/...`, `qyapi.weixin.qq.com/...key=...`, `oapi.dingtalk.com/...access_token=...`), query tokens, and any literal secret strings from `extra_secrets` or local credential store -> `[REDACTED]`.
    2. **Layer 2 (Host Paths & Usernames)**: replace `repo_path` with `<repo>`, `C:\Users\<name>` / `/Users/<name>` / `/home/<name>` with `<home>`, and any remaining absolute Windows/POSIX paths (`D:\...`, `/var/...`, `/opt/...`) with `<path>/...` (counting `paths_anonymized`).
    3. **Layer 3 (Network & Identity)**: replace email addresses with `[REDACTED_EMAIL]` and private IPv4 literals with `[REDACTED_IP]` (counting `emails_redacted` and `ips_redacted`, without corrupting semantic version strings like `1.0.4` or timestamps).
    4. **Layer 4 (Code & Stack Stripping)**: omit RFC正文, raw git diffs (`diff --git`, `@@ ... @@`, `+++`/`---`), and multi-line stack trace blocks (`Traceback (most recent call last): ...` / `  at ... (file:line)`); when `include_review_summaries=False`, replace review summaries with canonical status labels (`Passed review` / `Review revision requested`). When `anonymize_run_id=True`, replace source `run_id` with a stable hashed alias (`case-<short-hash>`).
  - **Graph & Trace Synthesis**:
    - Construct a valid, laid-out `WorkflowGraph` (`schema_version = "1.0"`, `id`, `name`, `nodes`, `edges`) matching the live run structure (`l0_planner` `planner_node`, milestone `reviewer_node` + task `worker_node` nodes with sanitized `config.provider` formatted via `DSH` where `dsh_opencode` is displayed, plus `l0_final_gate` `human_gate_node`), validated internally via `validate_graph` with zero cycle errors.
    - Convert chronological SQLite `events` (and task/milestone transitions) into sanitized `GraphTraceEvent[]` steps (`seq`, `kind`, `node_id`, `edge_id`, `outcome`, `timestamp`, `message`, normalized without leaking secrets/paths).
    - Build `meta`: `source_run_id`, `status`, `elapsed_sec`, `milestones_passed`, `milestones_total`, `tasks_passed`, `tasks_total`, `gate_catches`, `whitelist_catches`, `escalations`, `models`, `stages`, `billing`.
    - Run a post-serialization regex audit on the output JSON string so `redaction_report["clean"] = True` verifies zero secret patterns survived.
- **REST API & CLI**:
  - `src/vibebaton/web_server.py`: add route `GET /api/runs/([^/]+)/case-export` returning JSON bundle (HTTP `200`) with query parameters `title`, `include_reviews` (`"1"`/`"0"`), `anonymize` (`"1"`/`"0"`), returning `404` when `run_id` does not exist.
  - `src/vibebaton/cli.py`: add `baton export-case --repo . --run-id <id> [--config ...] [--out <path>] [--title "..."] [--no-reviews] [--anonymize]` printing redaction summary and writing `.baton-case.json` cleanly.
  - `tests/test_case_export.py`: unit & integration tests covering all 4 redaction layers, post-serialization secret audit (`clean=True`), `validate_graph(bundle["graph"])`, valid non-empty `trace`, `no-reviews` and `anonymize` modes, `baton export-case` CLI, and `GET /api/runs/{id}/case-export` HTTP endpoint (404 + 200).

### M2: Frontend Case Model, Stage 1 Tutorial Wrapper & Intuitive Recipe/Case Transfer Modals

- **`web/src/types/graph.ts` & `web/src/engine/caseReplay.ts` (+ `web/src/engine/caseReplay.test.ts`)**:
  - Define TypeScript interfaces: `CaseRedactionReport`, `CaseReplayMeta`, `BatonCaseBundle` (`schema_version: 'baton-case/v1'`, `case_id`, `title`, `summary`, `created_at`, `meta`, `redaction_report`, `graph`, `trace`, optional `isOfficialTutorial?: boolean`).
  - `parseAndValidateCaseBundle(raw: unknown)`: validates `baton-case/v1`, calls `validateGraph(bundle.graph)`, checks non-empty `trace`, and flags client-side residual secret warnings if a user edits raw JSON manually.
  - `isCaseBundleInput(parsed: unknown)`: distinguishes a `.baton-case.json` Case Bundle from a `.baton.json` Recipe Blueprint (`WorkflowGraph`) cleanly during import auto-detection.
  - `buildOfficialStage1Case(locale: Locale): BatonCaseBundle`: builds the official Stage 1 tutorial case (`case_id: 'official-stage1'`) using existing `flagship_4tier`, `STAGE1_REPLAY_META`, and `STAGE1_REPLAY_TRACE` / `STAGE1_REPLAY_TRACE_ZH` (keeping `stage1Replay.test.ts` untouched and passing).
  - `readSavedCases()` / `writeSavedCases()` localStorage persistence helpers (`vibebaton.importedCases.v1`, safe try/catch, bounded history cap up to 10 cases).
- **`web/src/api/client.ts` & `web/src/api/client.test.ts`**:
  - Add `exportRunCase(runId, options?: { title?: string; includeReviews?: boolean; anonymize?: boolean }): Promise<BatonCaseBundle>` calling `GET /api/runs/{id}/case-export` in `local` mode and returning a valid demo bundle in `demo` mode.
- **`web/src/components/RecipeTransferModals.tsx` + `RecipeTransferModals.css` + `RecipeTransferModals.test.ts`**:
  - Build three clear, responsive, accessible modals with full `EN | 中文` copy (`messages.transfer`):
    1. **`ImportTransferModal`**: opens via file picker / drag-drop OR text paste (`.baton.json` recipe JSON, `#recipe=` share URL, or `.baton-case.json` case JSON); automatically detects Recipe vs Case, shows a structured **Preview Card** (name/title, type badge, node & edge counts, validation/redaction health badge, duration & task summary for cases), and executes confirm action (`Apply Recipe to Canvas` or `Load & Replay Case`).
    2. **`ExportRecipeModal`**: shows active blueprint (`graph.name`, node & edge counts), security assurance badge (`Workflow structure only — zero code or API keys`), smart advisory banner if currently viewing a Live Run (`liveViewActive`) offering 1-click switch to `ExportCaseModal`, plus buttons: **Download `.baton.json`**, **Copy JSON** (with collapsible preview), and **Copy `#recipe=` Share Link**.
    3. **`ExportCaseModal`**: fetches sanitized case via `client.exportRunCase`, lets user customize `title` and toggle `Include sanitized review summaries` / `Anonymize run ID`, renders the **Redaction Safety Checklist** (`secrets_redacted`, `paths_anonymized`, `raw_diff_stripped`, verified clean pill), and provides **Download `.baton-case.json`**, **Copy Case JSON**, and **Preview in Replay Player**.

### M3: LeftSidebar Redesign, Universal Case Replay PlaybackBar, Tutorial Update & `v1.0.4` Release

- **`web/src/components/LeftSidebar.tsx` & `LeftSidebar.css`**:
  - Replace the bare `Import / Export` section with **Save, Import & Share (`配方与案例分享`)**: concise explanatory subtitle explaining **Recipes (`.baton.json`)** vs **Run Cases (`.baton-case.json`)** + clear two-line action cards (icon + action title + plain one-line description) opening `ImportTransferModal`, `ExportRecipeModal`, and (when a local or selected run exists) `ExportCaseModal`.
- **`web/src/components/inspector/LiveRunPanel.tsx`**:
  - Add **Share Case (`分享案例`)** button beside `Battle Report` triggering `onOpenCaseExport` for the currently selected run.
- **`web/src/components/PlaybackBar.tsx`, `web/src/components/types.ts`, `web/src/App.tsx`**:
  - Upgrade `PlaybackBar`:
    - Accept `activeCaseTitle`, `savedCases`, `activeCaseId`, `replayCaseLabel`, `onSelectReplayCase`, `onImportCaseRequest`, `isCustomCaseActive`:
    - When using the default tutorial, show **`Tutorial: Stage 1 (60×)` / `示范教程：一期真跑`** with a short tooltip pointing to case import;
    - When a community/exported `.baton-case.json` case is loaded (`activeCaseId !== 'official-stage1'`), the replay trigger button turns into a clear **`▶ Start: <Case Title>` / `▶ 开始回放：<案例名>`** (plus a compact switcher/dropdown to jump between imported cases, import another `.baton-case.json`, or reset back to `Official Tutorial: Stage 1`).
    - When `PlaybackBar` plays any case, `App.tsx` loads that case's `graph` onto `CanvasWorkspace` and drives `trace` with smooth animation, particle flow, node states, and right-pane trace commentary, plus a subtle summary pill (`elapsed · passed/total tasks · sanitized replay`).
- **Tutorial & i18n Updates (`web/src/components/QuickStartModal.tsx`, `web/src/i18n/messages.ts`, `docs/TUTORIAL.md`)**:
  - Update `QuickStartModal` & `docs/TUTORIAL.md` so the Stage 1 example explicitly serves as the interactive tutorial for importing and replaying shared `.baton-case.json` cases, and document the Recipe vs Case distinction cleanly.
  - Full `EN | 中文` parity in `web/src/i18n/messages.ts` (`i18n.test.ts` clean: zero CJK in EN, Han required in ZH, zero `/opencode/i` in UI copy).
- **Release Metadata & Bridge Note (`1.0.4`)**:
  - Bump version to `1.0.4` in `pyproject.toml`, `src/vibebaton/__init__.py`, `web/package.json`, `tests/test_version_consistency.py`.
  - In `CHANGELOG.md`: add a concise 1-sentence clarifying note under `## [v0.9.0-beta] - 2026-11-22` (`Pre-1.0 feature-complete public beta integrating Recipe Plaza, Smart Allocation, Launch Gate, Live Sync, Bilingual Reports, and Benchmarks after v0.3.0.`) AND append `## [v1.0.4] - 2026-11-22` at the bottom after `## [v1.0.3] - 2026-11-22`.
  - Add Stage 4.8 (`v1.0.4`) summary entry at the end of `docs/ROADMAP.md`.

## Verification & Acceptance Criteria

Run all automated verification suites cleanly:

```bash
cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"
cmd /c "set PYTHONPATH=src&& set PYTHONUTF8=1&& set VIBEBATON_DISABLE_PRICING_SYNC=1&& python -m unittest discover -s tests -v"
```

1. `tests/test_case_export.py` verifies all 4 redaction layers (secrets, paths, emails/private IPs, raw diffs/stack traces), `clean=True` post-serialization audit, valid `validate_graph` output, `baton export-case --help` / execution, and `GET /api/runs/{id}/case-export` HTTP responses.
2. `web/src/engine/caseReplay.test.ts` and `web/src/components/RecipeTransferModals.test.ts` verify Recipe vs Case auto-detection, preview confirmation before overwrite, official Stage 1 tutorial case fallback, localStorage persistence, and case replay playback.
3. Frontend `npx.cmd vitest run`, `npx.cmd tsc --noEmit`, and `npm.cmd run build` exit `0` with `i18n.test.ts` passing (zero CJK in EN, Han in ZH, zero `/opencode/i`, `DSH` consistent).
4. `python -m vibebaton --version` outputs `vibebaton 1.0.4` and `python -m vibebaton export-case --help` exits `0`.
5. Full backend test suite (`python -m unittest discover -s tests -v`) passes with `test_version_consistency.py` and `test_release_collateral.py` green.
6. Exporting a real run (such as Stage 4.7) via `baton export-case` produces a valid `.baton-case.json` with `redaction_report.clean == true` that imports cleanly into the universal replay player.
