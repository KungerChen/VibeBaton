# Master RFC: Stage 4.6 (v1.0.2) — Explicit Overnight Notifications & Attention Alerts

## Goals

Eliminate silent hangs in unattended `overnight` and interactive VibeBaton runs by making every human-blocking or attention-requiring condition loudly, explicitly, and reliably visible across four surfaces:

1. **Structured Attention Audit & Telemetry (`engine.py`, `report.py`)**:
   - Emit structured `human_attention_required` events into SQLite (`events` table) with episode deduplication across all six audited attention states:
     1. Task-level `WAITING_HUMAN` (`PLAN_AMENDMENT` or exhausted merge conflict resolution);
     2. Milestone-level `WAITING_HUMAN` (`PLAN_AMENDMENT` or exhausted milestone merge conflict resolution);
     3. `READY_FOR_FINAL_GATE` (all milestones passed into `dev`, ready for L0 final gate sign-off);
     4. Hard failure halt `FAILED` (missing RFC, planner failure, milestone failure, DAG deadlock, or unhandled exception);
     5. Long provider quota cooldown (`wait_sec >= notifications.on_long_cooldown_sec` when threshold > 0);
     6. External/manual `PAUSED` observed by the execution loop.
   - Expose an additive `attention` object in `compute_run_telemetry` (`None` when running cleanly or `COMPLETED`).

2. **Pure-Stdlib Multi-Channel Host Notifier (`notifier.py`, `config.py`, `cli.py`)**:
   - Dispatch non-blocking, failure-isolated host notifications whenever an enabled attention condition triggers:
     - Optional signed/configured incoming webhook (`webhook_url` or `webhook_url_env`, supporting `auto`, `feishu`, `wecom`, `dingtalk`, `slack`, `discord`, and `generic` JSON payloads);
     - Windows native desktop toast/balloon notification via PowerShell with graceful silent no-op fallback on non-Windows or headless hosts;
     - Terminal bell (`\a`) when running interactively.
   - Add `baton notify-test` CLI command so users can test webhook, toast, and bell configuration before launching an overnight run.

3. **Web Studio Global Attention Banner, Browser Notifications, Tab Flashing & Audio Chime (`v1.0.2`)**:
   - Render a prominent, accessible `role="alert"` global `<AttentionBanner>` across the top of Studio whenever the selected/live run enters an attention state, displaying severity, exact blocker prompt/summary, and one-click actions (Approve / Reject with optional note for `WAITING_HUMAN`, Open Battle Report for `READY_FOR_FINAL_GATE`, Resume for `PAUSED`, Dismiss for current alert fingerprint, Enable Browser Notifications).
   - Flash the document title (`[⚠ ...]`) while an attention alert is unresolved, fire a single deduplicated Web Notification (when permission is granted), and play a crisp Web Audio chime respecting existing `soundEnabled` and `soundVolume` localStorage preferences.
   - Complete `EN | 中文` localization parity and bump release metadata cleanly to `1.0.2`.

## Constraints

- **Zero new Python runtime dependencies**: `notifier.py` and `cli.py` must use Python 3.11+ standard library modules only (`urllib.request`, `urllib.parse`, `subprocess`, `json`, `os`, `sys`, `dataclasses`, `time`).
- **Zero new npm dependencies**: Do NOT run `npm install` or edit `package-lock.json`; only bump `"version": "1.0.2"` in `web/package.json`. On Windows, invoke `npx.cmd` and `npm.cmd`.
- **Backward compatibility**:
  - Legacy `baton.toml` / `.baton/baton.toml` files without `[notifications]` must load cleanly with safe defaults (`NotificationSettings()`).
  - Existing CLI subcommands, 9 MCP tools, and legacy battle-report output bytes must remain unchanged.
  - Real network HTTP requests and real OS toast subprocesses must NEVER execute during automated `unittest` runs; inject mock/fake senders in tests.
  - `notify()` must catch and log/report channel delivery errors in `NotificationResult` and must NEVER crash `OrchestrationEngine.execute_run()`.
- **UI & i18n Guarantees (`web/src/i18n/i18n.test.ts`)**:
  - Default locale is pure English (`en`) with zero CJK characters in `MESSAGES.en` and `zh` parity containing Han characters.
  - Never expose `OpenCode` in user-facing copy (display `DeepSeek API` everywhere).
  - Preserve existing `.app` CSS layout (`54px` header row) when `AttentionBanner` is hidden (`null`), and use `.app:has(> .attention-banner)` for responsive grid row placement on desktop (`54px auto 1fr`) and mobile `< 960px` (`minmax(54px, auto) auto auto minmax(0, 1fr)`).
- **CHANGELOG Ordering & Cleanliness**:
  - `CHANGELOG.md` lists releases oldest-first: append `## [v1.0.2] - 2026-11-22` strictly at the end after `## [v1.0.1] - 2026-11-22`, with zero HTML worker log comments.

## Non-Goals

- Do NOT introduce SMTP email servers, external SDK dependencies (Slack/Feishu/Twilio pip packages), or third-party tray-icon libraries.
- Do NOT auto-approve `WAITING_HUMAN` gates or bypass human sign-off under any policy.
- Do NOT break or alter `SplitHandle`, `LiveRunPanel` accordions, `liveClock` live counters, or `GuidedTourOverlay` introduced in `v1.0.1`.

## Architecture & Deliverables (Milestones M1–M3)

### M1: Notification Configuration, Pure-Stdlib Multi-Channel Notifier & Tests

- **`src/vibebaton/config.py`**:
  - Add `@dataclass class NotificationSettings`:
    - `enabled: bool = True`
    - `desktop_toast: bool = True`
    - `terminal_bell: bool = True`
    - `webhook_url: str = ""`
    - `webhook_url_env: str = ""`
    - `webhook_format: str = "auto"` (validated against `auto`, `generic`, `slack`, `discord`, `feishu`, `wecom`, `dingtalk`)
    - `webhook_timeout_sec: float = 5.0`
    - `on_waiting_human: bool = True`
    - `on_ready_for_final_gate: bool = True`
    - `on_failed: bool = True`
    - `on_paused: bool = True`
    - `on_long_cooldown_sec: int = 300`
  - Add `notifications: NotificationSettings = field(default_factory=NotificationSettings)` to `BatonConfig` and parse optional `[notifications]` table in `parse_config_dict`.
- **`src/vibebaton/notifier.py`**:
  - Define dataclasses:
    - `AttentionEvent(run_id, category, severity, title, message, action_hint, milestone_id=None, task_id=None, created_at=...)`
      where `category` covers `"waiting_human"`, `"ready_for_final_gate"`, `"failed"`, `"paused"`, `"long_cooldown"`, and `"test"`; `severity` covers `"warning"`, `"error"`, `"info"`.
    - `NotificationResult(dispatched, skipped_reason, channels)` with per-channel delivery results (`{"channel": ..., "ok": bool, "detail": str}`).
  - Implement `resolve_webhook_url(settings: NotificationSettings, credentials_path: Path | None = None) -> str` reading direct `webhook_url`, `os.environ.get(settings.webhook_url_env)`, or local credential store key `settings.webhook_url_env` without leaking secret URLs in error messages.
  - Implement `detect_webhook_format(url: str, configured: str = "auto") -> str` and `format_webhook_payload(event: AttentionEvent, webhook_url: str, fmt: str = "auto") -> dict[str, Any]` producing valid payloads for:
    - `feishu` (`open.feishu.cn` / `larksuite.com`): `{"msg_type": "text", "content": {"text": ...}}`
    - `wecom` (`qyapi.weixin.qq.com`): `{"msgtype": "text", "text": {"content": ...}}`
    - `dingtalk` (`oapi.dingtalk.com`): `{"msgtype": "text", "text": {"content": ...}}`
    - `slack` (`hooks.slack.com`): `{"text": ...}`
    - `discord` (`discord.com/api/webhooks` / `discordapp.com`): `{"content": ...}`
    - `generic`: structured JSON dict (`{"event": "human_attention_required", "run_id": ..., "category": ..., "severity": ..., "title": ..., "message": ..., "action_hint": ..., "milestone_id": ..., "task_id": ..., "timestamp": ...}`).
  - Implement `AttentionNotifier` with optional dependency-injected `http_sender`, `toast_runner`, and `bell_stream` (plus safe default Windows PowerShell BurntToast-free NotifyIcon BalloonTip script encoded cleanly without shell injection, and clean fallback when non-Windows or unavailable). Provide `should_notify(category, settings, wait_sec=None) -> bool` and exception-safe `notify(event, settings) -> NotificationResult`.
- **`baton.example.toml`** & **`tests/test_notifier.py`**:
  - Document commented `[notifications]` block in `baton.example.toml` with zero real webhook secrets.
  - Add thorough unit tests in `tests/test_notifier.py` covering TOML parsing defaults + overrides, all 6 webhook payload formats + auto-detection, `webhook_url_env` lookup + masked logging, error isolation when HTTP/toast fails, cooldown threshold gating, and mock desktop toast + terminal bell invocation.

### M2: Engine Integration Across All 6 Blocking States, Attention Telemetry & `baton notify-test`

- **`src/vibebaton/engine.py`**:
  - Extend `OrchestrationEngine.__init__` with optional `notifier: AttentionNotifier | None = None` (defaults cleanly to `AttentionNotifier(credentials_path=self.credentials_path)`).
  - Add episode deduplication tracking (`self._notified_episodes: set[tuple[str, str, str]]`) and helper `async def _emit_attention(...)` (or sync/threaded wrapper using `asyncio.to_thread` for network/subprocess channels so the asyncio event loop never blocks while calling webhooks or toast) that:
    1. Logs `"human_attention_required"` event via `self.store.log_event(...)` with `task_id`, `milestone_id`, and JSON payload (`category`, `severity`, `title`, `message`, `action_hint`, `channels`);
    2. Dispatches `notifier.notify(event, cfg.notifications)` safely inside try/except.
  - Wire `_emit_attention` into every blocking/attention path:
    1. Missing RFC, planner failure, or top-level unhandled exception -> `failed`;
    2. Milestone failure or DAG deadlock -> `failed`;
    3. Task-level `WAITING_HUMAN` (`PLAN_AMENDMENT` or `MergeConflictError`) surfaced in `_execute_milestone` -> `waiting_human` (milestone + task IDs preserved);
    4. Milestone-level `WAITING_HUMAN` (`PLAN_AMENDMENT` or `MergeConflictError`) in `_run_milestone_gate_and_review` -> `waiting_human`;
    5. `READY_FOR_FINAL_GATE` -> `ready_for_final_gate`;
    6. External `PAUSED` detected inside `_execute_milestone` / `execute_run` -> `paused`;
    7. Provider quota cooldown wait in `_invoke_role` when `cooldown >= cfg.notifications.on_long_cooldown_sec` (if `on_long_cooldown_sec > 0`) -> `long_cooldown` (and emit once per cooldown episode).
- **`src/vibebaton/report.py`**:
  - Add additive `attention` field to `compute_run_telemetry`:
    - When `run_status in ("WAITING_HUMAN", "READY_FOR_FINAL_GATE", "FAILED", "PAUSED")`, build `attention` from the latest `"human_attention_required"` event if present OR synthesize cleanly from `run["status"]`, `run["human_prompt"]`, `run["summary"]`, latest error/milestone so legacy databases without `"human_attention_required"` events still surface clear attention banners in Web Studio.
    - When `run_status in ("RUNNING", "PLANNING")` and any task is currently in `COOLDOWN` with a recent `quota_rate_limited`/`quota_cooldown_wait` or `"human_attention_required"` (`category == "long_cooldown"`), expose active cooldown attention cleanly.
    - When running normally or `COMPLETED`, set `attention` to `None` (or omit when `unplanned pending` legacy run matches existing contract tests). Verify all existing `tests/test_report*.py` tests remain 100% passing.
- **`src/vibebaton/cli.py`**:
  - Add `notify-test` subcommand (`baton notify-test [--repo .] [--config ...] [--webhook-url ...] [--message "..."]`) invoking `AttentionNotifier` with explicit `--webhook-url` override or `[notifications]` settings, printing per-channel delivery status (`OK` / `SKIP` / `FAIL`) cleanly and returning non-zero only if a requested enabled channel actively errored when explicitly forced or malformed URL provided.
- **`tests/test_engine_notifications.py`**:
  - Integration tests using fake/stub CLI runners and injected `AttentionNotifier` verifying:
    - All 6 engine states log `human_attention_required` and trigger notifier exactly once per episode;
    - Short cooldown (`< on_long_cooldown_sec`) stays silent while long cooldown (`>= on_long_cooldown_sec`) triggers `long_cooldown`;
    - Webhook failure does NOT fail or hang the engine run;
    - `compute_run_telemetry` returns structured `attention` for active blocking states and `None` after resolution/completion (and works for legacy runs lacking `human_attention_required` events);
    - `baton notify-test` CLI command executes cleanly.

### M3: Web Studio Global `AttentionBanner`, Browser Notification, Tab Flash, Audio Chime & `v1.0.2` Release

- **`web/src/types/graph.ts` & `web/src/types/graph.test.ts`**:
  - Define `AttentionSeverity = 'warning' | 'error' | 'info'`, `AttentionCategory = 'waiting_human' | 'ready_for_final_gate' | 'failed' | 'paused' | 'long_cooldown'`, `RunAttentionState` (`category`, `severity`, `title`, `message`, `action_hint`, `milestone_id`, `task_id`, `created_at`), and optional `attention?: RunAttentionState | null` on `RunTelemetry`.
- **`web/src/i18n/messages.ts`, `web/src/i18n/liveEvents.ts`, `web/src/i18n/liveEvents.test.ts`**:
  - Add `messages.attention` namespace in both `en` (pure English, zero CJK) and `zh` (full Han localization) covering banner titles by category, action labels (Approve, Reject, Resume, View Battle Report, Enable Desktop Alerts, Notifications Enabled, Notifications Blocked, Dismiss), default detail fallbacks, and `[⚠ ...]` document title prefix.
  - Add `human_attention_required` formatting in `liveEvents.ts` + tests in `liveEvents.test.ts`.
- **`web/src/engine/attentionAlerts.ts` & `web/src/engine/attentionAlerts.test.ts`**:
  - Pure, testable helpers:
    - `deriveAttentionAlert(snapshot: LiveRunSnapshot | null)`: reads `snapshot.telemetry?.attention` or falls back smoothly from `snapshot.run?.status` (`WAITING_HUMAN`, `READY_FOR_FINAL_GATE`, `FAILED`, `PAUSED`) so both v1.0.2 snapshots and older snapshots work seamlessly.
    - `buildAlertFingerprint(runId, alert)`: deterministic string used for one-shot sound/notification deduplication and user dismissal per episode.
    - `formatAttentionDocumentTitle(baseTitle, alert, locale, tickOdd)`: returns crisp alternating attention title when active and restores `baseTitle` when cleared.
    - `dispatchBrowserNotification(alert, locale, permission, NotificationCtor)` with injectable constructor for Vitest.
    - `playAttentionChime(category, enabled, volume, audioCtor)` synthesizing a clean dual-tone Web Audio alert using the existing `LiquidWebAudioEngine` preferences (`soundEnabled`, `soundVolume`) without throwing in non-browser/muted environments.
- **`web/src/components/AttentionBanner.tsx`, `web/src/components/AttentionBanner.css`, `web/src/components/AttentionBanner.test.ts`**:
  - Accessible `role="alert"` banner component anchored full-width below `HeaderBar`:
    - Displays category badge, localized title, concise monospace `run_id`, blocker message (`human_prompt` / summary), and action buttons (`Approve` / `Reject` for `WAITING_HUMAN`, `Resume` for `PAUSED`, `Battle Report` trigger or jump-to-inspector for `READY_FOR_FINAL_GATE`, optional `Enable Browser Alerts` CTA when `Notification.permission === 'default'`, and `Dismiss`).
- **`web/src/App.tsx`, `web/src/index.css`, `web/src/components/inspector/LiveRunPanel.tsx`**:
  - Wire `deriveAttentionAlert(liveSnapshot)` in `App.tsx`, manage dismissed fingerprint, one-shot browser notification + Web Audio chime on new alert arrival, document title flash interval while unresolved, and action handlers calling existing `client.controlRun(...)` / opening Battle Report modal or switching inspector tab cleanly.
  - Ensure `AttentionBanner` works cleanly at `1440×900` and `375×667` without horizontal overflow or layout overlap.
- **Release Metadata & Collateral (`1.0.2`)**:
  - Update version to `1.0.2` in `pyproject.toml`, `src/vibebaton/__init__.py`, `web/package.json`.
  - Append `## [v1.0.2] - 2026-11-22` at the bottom of `CHANGELOG.md` (oldest-first order preserved, zero HTML comments).
  - Add Stage 4.6 (`v1.0.2`) summary entry at the bottom of `docs/ROADMAP.md`.
  - Update `RELEASE_VERSION = "1.0.2"` in `tests/test_version_consistency.py` (keeping all collateral tests green).

## Verification & Acceptance Criteria

All automated unit tests, integration tests, static type checks, production builds, and release consistency checks must exit `0`:

```bash
cmd /c "cd /d web && npx.cmd vitest run && npx.cmd tsc --noEmit && npm.cmd run build"
cmd /c "set PYTHONPATH=src&& set PYTHONUTF8=1&& python -m unittest discover -s tests -v"
```

1. All automated backend tests pass (`python -m unittest discover -s tests -v`), including new `tests/test_notifier.py` and `tests/test_engine_notifications.py`, without sending real network requests or launching real desktop notifications in tests.
2. `python -m vibebaton --version` prints `vibebaton 1.0.2`.
3. `python -m vibebaton notify-test --help` prints valid usage and `baton notify-test` executes cleanly against mocked/configured channels.
4. All automated frontend Vitest suites pass (`npx.cmd vitest run`), including new `attentionAlerts.test.ts` and `AttentionBanner.test.ts`, and `i18n.test.ts` guarantees zero CJK in `en`, Han characters in `zh`, and zero `OpenCode` copy leaks.
5. `npx.cmd tsc --noEmit` and `npm.cmd run build` pass with exit code `0`.
