# Guided M3 frontend contract

This contract connects the existing Studio client to the [session](session_contract.md)
and [lineage](lineage_contract.md#guided-http-lineage-contract) APIs. M3 leaf
components receive data and callbacks from their parent. They use `useI18n()`
for copy and do not call `fetch` or construct API clients. The implementation
pattern is `GuidedFailedBanner.tsx` with its CSS and `*.test.ts`.

## Session and launch

`useGuidedSession(api, debounceMs = 400)` accepts a stable `GuidedSessionApi`
and exposes `session`, `loading`, `saving`, `error`, `save`, `flush`,
`ensureLaunchRequestId`, and `reset`. The API is the existing
`BatonApiClient`; its session methods return the unwrapped session document.
`save` applies a partial patch to the local view and debounces a server write.
Writes are serialized; failed patches remain queued and `flush()` rejects
until they are saved. Lineup map deletions and clear-then-add sequences retain
the server's merge semantics. `reset()` waits for a started write, discards
queued edits only after a successful reset, and restores them if reset fails.

Before switching the server workspace or unmounting the session owner, await
`flush()`. Keep the API object stable for a workspace. A change of API object
invalidates responses from its predecessor. On restoration, fetch the current
run and gate state before enabling actions; stored drawer state is only UI
state. On `BRAINSTORM_SESSION_CHANGED`, reload the server session before
retrying. Keep credentials out of session documents.

Use `listLineageRuns`, `getLineageRun`, or `getLatestLineageRun` for typed
lineage fields. The existing run readers retain their original signatures.

For each launch intent, call `await ensureLaunchRequestId()` before invoking
`startGuidedRun`. The hook saves the ID before returning it; retries of the
same intent reuse it even after a timeout or a failed session save. A replay
can return `daemon_pid: null` and `reused: true`. Explicitly clear and save
`workflow.launch_request_id` only when starting a different intent. The
structured lineup is mutually exclusive with legacy role/model overrides.
Read `ApiError.data` for launch fallback details and a `run_id` returned after
a session-write failure.

`approveAndMerge` returns `merged`, `reintegrated`, `conflict`, or
`gate_failed`; other errors throw `ApiError`. A direct merge does not imply
that new integration gates ran. Re-integration reports its gate results.
Conflict and gate failure retain the server's details. Compare base drift to
the **root** run's `start_sha`, not the latest revision's `start_sha`.
`requestChanges` returns the child ID and supersedes the parent;
`rollbackRun` accepts `revert_revision`, `abandon_all`, or `undo`;
`stopAndReplan` returns the failure context. A `FAILED` lineage run can be
stopped for replanning; a completed run cannot be stopped or revised.

The workbench shares one session owner with Setup and Blueprint and flushes it
before a workspace switch. A sign-off revision first saves the requested note,
then stops the settled parent and opens Blueprint with that note and the prior
RFC. Starting the edited blueprint calls `requestChanges` on the stopped parent;
the note sent to the server includes the revised RFC. This endpoint inherits
the parent's workflow and lineup, so those controls are locked for the child
and the server revalidates them. A sign-off revision is not labeled or sent as
a failed run; a failure replan retains its failure context. An uncertain revision response can be recovered
only when the parent event identifies both the child and the exact saved note.
The session reset clears the draft and view state; it does not stop a run.
After a merge is restored, the historical event supplies the pre-merge target;
the rollback endpoint checks the live base head and rejects a moved head before
changing it. The UI states that this check occurs on the server.

## Leaf component props

The following are the interfaces for M3 workers. Optional callbacks determine
whether an action is available; parents validate current server status before
supplying them. `error` and `detail` values are text, not HTML.

```ts
import type {
  CliDriver, CliRegistryScanResponse, L0ModelOption, RunLineageFields,
  RunStatus, WorkflowMode,
} from '../../api/client';

interface CliSummaryBarProps {
  scan: CliRegistryScanResponse['scan'] | null;
  scanning: boolean;
  onScan(): void;
  onOpenDetails(): void;
}

interface InstallConfirmPopoverProps {
  driver: CliDriver;
  open: boolean;
  busy: boolean;
  error?: string | null;
  onConfirm(): void;
  onCancel(): void;
}

interface L0ModelSwitcherProps {
  models: L0ModelOption[];
  selected: string | null; // null selects automatic mode
  autoSelected: string | null;
  loading: boolean;
  error?: string | null;
  onChange(spec: string | null): void;
  onRetry(): void;
}

interface WorkflowSwitchPillProps {
  currentSize: 'small' | 'medium' | 'large' | null;
  recommendedSize: 'small' | 'medium' | 'large' | null;
  recommendedMode?: WorkflowMode;
  disabled?: boolean;
  onSwitch(): void;
  onDismiss(): void;
}

interface LineageSummaryProps {
  runId: string;
  status: RunStatus | (string & {});
  lineage: RunLineageFields;
  rootStartSha: string | null; // drift baseline, supplied from the root run
  currentBaseSha: string | null;
  mergedSha?: string | null;
}

// Implemented golden example.
interface GuidedFailedBannerProps {
  detail?: string | null;
  onStopAndReplan?: () => void;
  busy?: boolean;
}
```

| Leaf | Permitted `guided.m3` copy |
| --- | --- |
| `CliSummaryBar` | `cliSummary.*`, `signin.highlight` |
| `InstallConfirmPopover` | `installConfirm.*` |
| `L0ModelSwitcher` | `l0Model.*` |
| `WorkflowSwitchPill` | `workflowSwitch.*`, `recommendation.sizeChanged`, `recommendation.small`, `recommendation.medium`, `recommendation.large`, `recommendation.unknownSize` |
| `LineageSummary` | `signOff.baseBranch`, `baseSha`, `startSha`, `resultSha`, `currentBaseSha`, `mergedSha`, `parentRun`, `currentRun`; `drift.title`, `drift.description` |
| `GuidedFailedBanner` | `failed.title`, `description`, `details`, `noDetails`, `replan`, `stopping`, `replanHint` |

Install confirmation displays the registry command and passes the driver's ID
to the parent's existing `installCli` callback; the server chooses the command.
The model switcher's `null` choice explicitly clears the saved selection.
WorkflowSwitchPill renders nothing when `currentSize === recommendedSize` or either is null; when they differ, it renders a non-intrusive pill with Switch (`onSwitch`) and Dismiss (`onDismiss`) actions, changing the proposed workflow rather than a running job. The lineage
summary displays the supplied SHAs; it does not infer the root from the child.
The failure banner shows Stop & Replan only when its callback is supplied.

## Bilingual copy key list

All names below are relative to `messages.guided.m3`; each exists in both
`en` and `zh`. The existing `guided` keys and signatures remain available.
Use the corresponding group for the stepper, setup, brainstorm, launch,
lineup, human gate, failure, sign-off, revision, rollback, drift, and session
flows. Do not add copy to `messages.ts` from parallel M3 leaf tasks.

For recommendations, map `reason_code` (or the suffix of the server's
`workflow.<reason_code>` explanation key) to `recommendation.reasons`. Use
`recommendation.unknownReason` for an unrecognized code. For an unknown HTTP
error code use `errors.unknown`, retaining the actual error details separately.

| Group | Keys |
| --- | --- |
| stepper | `aria`, `setup`, `blueprint`, `build`, `signoff`, `current`, `completed` |
| cliSummary | `title`, `ready`, `needsSignIn`, `missing`, `prerequisite`, `scan`, `scanning`, `rescan`, `details`, `empty` |
| installConfirm | `title`, `description`, `command`, `confirm`, `cancel`, `installing`, `success`, `failed` |
| signin | `title`, `description`, `action`, `opening`, `highlight`, `failed` |
| l0Model | `label`, `auto`, `selected`, `unavailable`, `loading`, `failed`, `retry`, `change` |
| brainstorm | `respondingModel`, `requestedModel`, `modelUnknown`, `offlineGuard`, `retry`, `retrying`, `preservedDraft`, `stale`, `reload` |
| launch | `title`, `action`, `launching`, `retry`, `confirm`, `blocked`, `uncertain`, `preflightFailed`, `activeRun` |
| lineup | `title`, `description`, `open`, `close`, `role`, `provider`, `model`, `effort`, `preset`, `useRecommendation`, `save`, `cancel`, `unavailable`, `missing`, `changed` |
| recommendation | `title`, `fallback`, `size`, `small`, `medium`, `large`, `unknownSize`, `unknownReason`, `mode`, `interactive`, `overnight`, `panel`, `substitutions`, `previousTeam`, `sizeChanged` |
| recommendation.reasons | `small_eco`, `medium_relay`, `large_panel`, `size_defaulted_to_medium`, `previous_lineup_preserved`, `eco_model_unavailable`, `provider_substituted`, `no_ready_provider`, `lineup_unavailable`, `preset_unavailable`, `synthesizer_not_configured`, `synthesizer_provider_unavailable`, `synthesizer_credentials_missing`, `panelist_unavailable` |
| workflowSwitch | `label`, `switchToPanel`, `switchToOvernight`, `switchAction`, `dismiss`, `panel`, `overnight`, `interactive`, `disabled`, `changed` |
| humanGate | `title`, `description`, `task`, `run`, `note`, `approve`, `reject`, `submit`, `submitting`, `close`, `stale`, `failed` |
| failed | `title`, `description`, `details`, `noDetails`, `retry`, `replan`, `stopping`, `replanHint` |
| signOff | `title`, `baseBranch`, `baseSha`, `startSha`, `resultSha`, `currentBaseSha`, `mergedSha`, `parentRun`, `currentRun`, `approve`, `merging`, `merged`, `reintegrated`, `gateFailed`, `conflict`, `changedFiles`, `gates`, `noGates` |
| revision | `title`, `note`, `placeholder`, `submit`, `submitting`, `required`, `created`, `context`, `parent`, `child`, `inheritedWorkflow` |
| rollback | `title`, `mode`, `revertRevision`, `revertRevisionHint`, `abandonAll`, `abandonAllHint`, `undo`, `undoHint`, `serverChecksHead`, `confirm`, `cancel`, `working`, `restored`, `paused`, `moved` |
| drift | `title`, `description`, `conflict`, `gateFailed`, `baseMoved`, `branchMoved`, `dirty` |
| session | `loading`, `loadFailed`, `saveFailed`, `retrySave`, `reset`, `resetConfirm`, `cancel`, `confirmReset` |
| errors | `RUN_SUPERSEDED`, `RUN_STALE`, `RUN_BUSY`, `STOP_PENDING`, `INTEGRATION_CONFLICT`, `GATE_FAILED`, `GATE_EXECUTION_FAILED`, `INVALID_GATES`, `BASE_MOVED`, `BASE_CHECKED_OUT`, `DIRTY_WORKTREE`, `MERGE_NOT_HEAD`, `LAUNCH_KEY_CONFLICT`, `LAUNCH_FAILED`, `REVISION_FAILED`, `INTEGRATION_FAILED`, `GIT_ERROR`, `LAUNCH_PREFLIGHT`, `READINESS_UNAVAILABLE`, `SESSION_IO_ERROR`, `BRAINSTORM_SESSION_CHANGED`, `unknown` |

## Implementation record: 20261126-131209-m3-t1-frontend-contract

- 2026-11-26 13:12 PST; branch `baton/e33e97/m3-t1`, baseline `71a9f73`.
  Scope: the ten M3-T1 whitelisted paths. `LOG.md` and its index are outside
  that whitelist, so this record is kept with the delivered contract.
- Added typed session, brainstorm, keyed launch, lineage, approval, revision,
  rollback and replan APIs; retained structured HTTP failure details. Added
  207 bilingual keys, the debounced session hook and the isolated failure
  banner, with regression tests and the leaf props above.
- `npm --prefix web test -- --configLoader runner` passed 62 files and 739
  tests; `npm --prefix web run typecheck` passed. The production build passed
  from this worktree with `--configLoader runner` and an output directory in
  the temporary verification root. Vite reported its existing large-chunk
  warning. The documented key list was checked against all 207 code keys.
- The exact `npm --prefix web test && npm --prefix web run build` command did
  not reach the build: the shared `web/node_modules` junction is read-only and
  Vite's default config loader failed with `EPERM` writing `.vite-temp`. An
  earlier isolated copy of 255 hash-checked files also could not run the exact command
  because esbuild could not read a restricted ancestor directory. The runner
  loader passed the same full tests and build without changing project config.
- Status: self-tested, pending user acceptance; the exact-command gate remains
  blocked, and a real browser visual/interaction check remains unverified. Browser setup was
  rejected because the tool requires approval while the policy forbids it.
  The hook and leaf are foundations for later M3 integration, so no live
  backend or end-to-end user flow was exercised here.
- Temporary verification copy and build output remain at
  `C:\Users\A\AppData\Local\Temp\vibebaton-m3t1-edf155f291df47e09e1c8f0f2bc3fadc`:
  the scoped cleanup command was rejected as `blocked by policy`. The baseline
  commit and this worktree's diff are the rollback reference; no commit or
  deployment was made.
