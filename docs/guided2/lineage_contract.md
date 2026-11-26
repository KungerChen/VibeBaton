# Run lineage contract

This contract defines the M1 database foundation and the Git interfaces for
subsequent lineage tasks. A `StateStore` normally belongs to one repository's
`.baton/state.sqlite`.

## Run columns

The five columns are nullable `TEXT`. On open, `PRAGMA table_info(runs)` guides
additive `ALTER TABLE` operations; existing columns and rows are preserved.
Repeated and concurrent opens are supported. Legacy rows have `NULL` in each
newly added column.

| Column | Meaning |
| --- | --- |
| `parent_run_id` | ID of the immediate previous run; `NULL` for a root or legacy run. |
| `base_ref` | Repository ref used as the integration target, normally `main`. |
| `start_sha` | Full commit SHA at which this run's work begins. For a revision, this is the parent's `result_sha`. |
| `result_sha` | Full commit SHA containing the reviewable result of this run; `NULL` until recorded. |
| `launch_request_id` | Client launch key. A partial unique index permits multiple `NULL` values and rejects duplicate non-`NULL` keys. |

The schema adds no parent foreign key to legacy tables. The chain reader detects
missing parents and cycles. The current `create_run` signature remains
unchanged: recording a launch key atomically with run creation and handling a
uniqueness conflict are responsibilities of the later launch implementation.
The unique index and lookup alone do not make the launch endpoint idempotent.

## Status transitions to `SUPERSEDED`

| Current status | May become `SUPERSEDED`? | Meaning |
| --- | --- | --- |
| `PENDING`, `PLANNING`, `RUNNING` | Yes | The caller must first stop scheduling and settle in-flight work. |
| `PAUSED`, `WAITING_HUMAN`, `READY_FOR_FINAL_GATE` | Yes | A revision replaces the existing run. |
| `COMPLETED`, `FAILED` | No | These already have a terminal outcome. |
| `SUPERSEDED` | Already terminal | Repeating the operation is a no-op; no transition out is allowed. |

The database conditionally performs the transition and sets `finished_at` once.
`update_run_status` and `record_human_decision` raise `ValueError` if they would
change a superseded run's status. A request to supersede a completed or failed
run also raises `ValueError`. Existing handling of other states is unchanged.
These database guards do not stop a worker or independently protect the HTTP,
CLI, and engine entry points; those lifecycle guards belong to M1-T3 and M1-T4.

## Database interfaces

```python
StateStore.set_run_lineage(
    run_id: str, *, parent_run_id: str | None,
    base_ref: str | None, start_sha: str | None,
) -> None
StateStore.set_run_result_sha(run_id: str, sha: str) -> None
StateStore.mark_run_superseded(run_id: str) -> None
StateStore.get_run_by_launch_request_id(request_id: str) -> dict[str, Any] | None
StateStore.get_active_run() -> dict[str, Any] | None
StateStore.get_run_lineage_chain(run_id: str) -> list[dict[str, Any]]
```

The setters update the named row and its `updated_at`; an unknown ID is a no-op,
consistent with existing run updates. `get_active_run` searches the entire
store for the newest `PENDING`, `PLANNING`, `RUNNING`, `PAUSED`,
`WAITING_HUMAN`, or `READY_FOR_FINAL_GATE` row, breaking timestamp ties by
newest inserted row. It returns `None` when none exists. It is a lookup, not an
atomic single-active-run reservation; callers that share a store across
repositories must account for that scope.

`get_run_lineage_chain` reads one consistent snapshot and returns complete run
rows ordered root first and requested run last. An unknown requested ID returns
`[]`; a missing ancestor or cycle raises `ValueError`. A caller that creates a
revision and supersedes its parent must arrange those writes in one transaction.

## SHA vocabulary

```text
main at launch:  A
first run:       A --work--> B          start_sha=A, result_sha=B
revision run:    B --work--> C          start_sha=B, result_sha=C
```

`A` is the root run's starting base commit, `B` is the first run's result, and
`C` is the revision result. Further revisions repeat the same parent-result to
child-start relation. For unmerged work, undoing the latest revision moves the
run branch from `C` to `B`; abandoning the whole chain moves it from `C` to
`A`. The intended resulting commit is exact, not merely an equivalent tree.

`main` can remain at `A` while revisions begin at `B` or `C`. Compare its
current head with the root's recorded base `A` when detecting base drift; a
revision's `start_sha` is not the base drift baseline. If `main` moves, later
tasks must re-integrate and rerun gates before updating the base ref.

## Git interfaces

```python
class LineageIntegrationResult(TypedDict):
    integrated_sha: str | None
    conflicts: list[str]

resolve_ref_sha(repo: Path, ref: str = "main") -> str
create_run_branch_at(repo: Path, branch: str, sha: str) -> str
has_ref_advanced(repo: Path, base_ref: str, recorded_sha: str) -> bool
integrate_in_isolated_worktree(
    repo: Path, base_ref: str, result_sha: str, *, worktree_root: Path | None = None,
) -> LineageIntegrationResult
revert_range(repo: Path, branch: str, from_sha: str, to_sha: str) -> str
reset_branch_to(repo: Path, branch: str, commit: str) -> str
is_head_commit(repo: Path, branch: str, commit: str) -> bool
```

- `resolve_ref_sha` returns a full commit SHA; invalid refs raise `GitError`.
- `create_run_branch_at` creates or resets a run branch to the specified SHA
  and returns its branch name. It refuses to move a checked-out branch.
- `has_ref_advanced` compares the resolved base with the recorded SHA; any
  mismatch, including a rewrite or rewind, counts as drift.
- `integrate_in_isolated_worktree` merges the result onto the selected base in
  a disposable worktree. `base_ref` accepts a commit SHA as well as a ref.
  Success returns `{"integrated_sha": sha, "conflicts": []}`;
  a conflict returns `{"integrated_sha": None, "conflicts": paths}`. Other
  Git failures raise `GitError`. Cleanup runs in both cases. Neither the user's
  worktree nor the base ref is changed. The returned commit contains both the
  selected base and the result in its ancestry (either may equal the returned
  SHA). To protect an advancing base, resolve it to a SHA, pass that immutable
  SHA as `base_ref`, run gates on the returned SHA, and use an atomic
  compare-and-swap to advance the branch only if it still points to that SHA.
- `revert_range` is an exact ref rewind for an **unmerged run branch**. It
  requires the current branch head to equal `from_sha` and `to_sha` to be an
  ancestor, then returns the full target SHA. It does not create a `git revert`
  commit. On a failed precondition it raises `GitError` without moving the ref.
- `reset_branch_to` is the existing implementation: check out the branch and
  hard reset it to `commit`, refusing uncommitted paths outside `.baton/`; it
  returns the supplied commit string. For merged undo, the caller must first
  verify that the merge commit remains the base head and protect against races.
- `is_head_commit` compares the resolved commit to the current branch head.

All interfaces except the already-existing `reset_branch_to` are stubs for
M1-T2. No Git lineage integration, endpoint, or engine lifecycle is claimed as
implemented by this task.

## Implementation record: 20261126-052219-m1-t1-lineage-contract

- 2026-11-26 05:22 PST; branch `baton/e33e97/m1-t1`, base
  `df387eb59fd8ab085f97ed2a4d4d2e0525eeb731`. Scope: the six M1-T1 allowed paths.
- Added the migration, DB helpers, terminal-status guards, Git contracts, and
  offline test fixtures. Preserved the existing `reset_branch_to` implementation
  and public signatures. A concurrent legacy-open test exposed a WAL lock race;
  initialization now retries busy/locked SQLite errors within a bounded window.
- The specified command passed 19 tests. In the worktree, full discovery ran
  800 tests with five skips and one error: the existing full-stack test's Vite
  build could not write through the shared `web/node_modules` junction outside
  the sandbox. A build using Vite's runner config loader succeeded in a temp
  directory with a chunk-size warning. The full suite was repeated in a temp
  copy of 399 hash-checked project files with those built assets: 800 tests,
  five skips, and one failure in `test_serves_built_canvas_and_stage3_api`.
  That unchanged test expects an ICO with three images; the unchanged baseline
  asset and the built asset both have eight. The same pre-existing mismatch is
  documented in `LOG.md` L0005. The remaining assertions in that test were not
  reached; the full-suite acceptance criterion is therefore not met.
- Status: implementation self-tested, full gate blocked by the existing test
  and asset mismatch, pending review. M1-T2 through M1-T5 remain responsible
  for the Git, engine, API and end-to-end lineage workflows. Correcting the
  unrelated full-stack assertion requires scope beyond the six allowed paths.
  The base commit and worktree diff are the rollback reference; no new commit
  has been made.
- Temporary verification copy: `C:\Users\A\AppData\Local\Temp\vibebaton-m1t1-zxz1bqsm`.
  Cleanup remains pending because the automatic execution policy rejected the
  scoped recursive delete as "blocked by policy".

## Guided HTTP lineage contract

The implementation below supersedes the M1-T1 stub statements above. New runs
started in a Git repository use the engine's per-run branch and immutable RFC
snapshot. They currently use `main` as `base_ref`. Pre-lineage runs and starts
outside a Git repository retain the legacy canvas behavior.

| Method and route | Request | Success |
| --- | --- | --- |
| `POST /api/runs/start` | Existing launch fields; optional `launch_request_id: string` | `201 {run_id, daemon_pid, status: "STARTED"}`. A replay returns `200 {run_id, daemon_pid: null, status, reused: true}`. |
| `GET /api/runs`, `/api/runs/latest`, `/api/runs/{id}` | Existing query | Existing shapes; each run includes `parent_run_id`, `base_ref`, `start_sha`, and `result_sha`, each `string` or `null`. |
| `POST /api/runs/{id}/finalize` | `{action: "revise", note: string}` | The revision response below; the parent is `SUPERSEDED`. |
| `POST /api/runs/{id}/request-changes` | `{note: string}` | Same revision response; also accepts a settled run stopped for replan. |
| `POST /api/runs/{id}/finalize` | `{action: "approve", note?: string}` | The approval response below; requires `READY_FOR_FINAL_GATE`. |
| `POST /api/runs/{id}/rollback` | `{mode: "revert_revision" \| "abandon_all" \| "undo", note?: string}` | `{ok: true, run_id, mode, status: "PAUSED", restored_to, base_branch, base_head}`. |
| `POST /api/runs/{id}/finalize` | `{action: "rollback", note?: string}` | Merged `undo`, with the legacy `action` and `backup_tag` fields retained. |
| `POST /api/runs/{id}/stop-and-replan` | `{timeout_sec?: number}` | `{ok: true, status: "SUPERSEDED", run_id, failed_tasks, last_errors, current_sha, run_summary}`. |
| `POST /api/runs/{id}/control` | `{action: "resume"}` | Existing response; terminal, stopping and stale runs are rejected. |

The first launch response is unchanged. A nonempty launch key of at most 256
characters is unique in the state store. The run ID is derived from its key,
and a connection-local SQLite trigger records the key in the engine's creation
transaction. A replay returns the existing row without spawning another daemon,
even when the original payload is omitted. A replay reports the stored status;
it does not restart a daemon if the original process stopped after committing
the row and before spawning it.

For a lineage revision, the response is:

```json
{
  "ok": true, "run_id": "parent", "action": "revise",
  "status": "SUPERSEDED", "backup_tag": null, "base_branch": "main",
  "base_head": "A", "revisions_path": ".../revisions.md",
  "revision_run_id": "child", "revision_status": "PENDING", "daemon_pid": 4242
}
```

The child starts at the parent's recorded `result_sha`, inherits its mode and
model overrides, and includes the revision note in its RFC snapshot. Parent
supersession and child creation use the engine's database transaction. A stopped
parent can be used once by `request-changes`; `finalize` on any superseded run
returns `RUN_SUPERSEDED`. `revision_status` is the child's stored status when
the response is sent and may have advanced beyond `PENDING`.

For lineage approval the response is:

```json
{
  "ok": true, "run_id": "child", "action": "approve", "status": "COMPLETED",
  "backup_tag": "baton-backup/child", "base_branch": "main", "base_head": "M",
  "merged_commit": "M", "changed_files": ["feature.txt"],
  "reintegrated": true,
  "gates": [{"command": "python -m unittest", "passed": true, "exit_code": 0,
             "stdout": "", "stderr": "", "duration_sec": 1.0}]
}
```

Drift compares the current base with the **root** run's starting SHA. On drift,
the server integrates the recorded result onto the observed base in a detached
worktree and reruns every recorded task `verify_cmd` and milestone
`gate_commands` across the lineage in a detached worktree at that exact
integrated commit. An empty configured list yields an empty `gates` list. The
base ref advances only after all gates pass: a Git reference transaction checks
both the observed base SHA and the recorded run-branch SHA. A changed base or
run branch requires a new approval attempt. A checked-out base is synchronized
only after a clean-checkout preflight; a base checked out in another worktree
is refused. Without drift, the previously gated result is advanced directly.
Git ref movement and the SQLite completion event are separate commits. If the
server stops or an I/O error occurs between them, inspect the base reflog, run
branch, and events before retrying finalization.

For unmerged `revert_revision`, the current run branch moves from its recorded
result to the immediate parent's result (`C -> B`). `abandon_all` moves it to
the root start (`C -> A`). Both require a settled branch matching the recorded
result, move only that branch, update its `result_sha`, and pause the run. The
rollback event records both the original and restored SHAs. Merged `undo`
returns the base to the approval's `pre_merge_head` only while the approval's
merge commit remains the base head. This preserves commits integrated before
approval. If the base has advanced, the response provides `git revert` guidance
and leaves the ref and run status unchanged.

Lifecycle rejections use HTTP 409 with `{"error": string, "code": string}`.
Stable codes include `RUN_SUPERSEDED`, `RUN_STALE`, `RUN_BUSY`, `STOP_PENDING`,
`INTEGRATION_CONFLICT`, `GATE_FAILED`, `GATE_EXECUTION_FAILED`, `INVALID_GATES`,
`BASE_MOVED`, `BASE_CHECKED_OUT`, `DIRTY_WORKTREE`, `MERGE_NOT_HEAD`,
`LAUNCH_KEY_CONFLICT`, `LAUNCH_FAILED`, `REVISION_FAILED`, `INTEGRATION_FAILED`,
and `GIT_ERROR`. Conflict responses add `conflicts: [string]` and `base_head`;
gate failures add `gates: [GateCommandResult]`; `MERGE_NOT_HEAD` adds
`merged_commit`, `base_head`, and `guidance`. A stop timeout retains the stop
request and must be retried after execution settles. Malformed input returns
400 and unknown run IDs return 404.

### Implementation record: 20261126-070746-m1-t4-guided-lineage-api

- 2026-11-26 07:07 PST; branch `baton/e33e97/m1-t4`, baseline `0c59e1a`.
  Authorized scope: the three M1-T4 paths. The project LOG and index are outside
  that whitelist, so this contract contains the traceable implementation record.
- Added transactional keyed launches, revision creation, drift integration and
  gates, guarded reference updates, explicit rollback modes, stop/replan and
  terminal/stale HTTP codes. Legacy rows retain the original finalization path.
- Baseline reproduction produced four rows for four concurrent identical keys
  and no per-run branch. The first combined gate passed 172 tests before the
  final reference-transaction and additional regression checks. An initial
  Windows reference transaction failed because text-mode stdin translated LF to
  CRLF; writing bytes fixed it. One interrupted test run briefly created an
  output file outside the whitelist; it was removed before rerunning the tests.
- Final verification: `python -m unittest tests.test_guided_lineage_api
  tests.test_guided_api tests.test_web_server -v` passed **178 tests** in
  109.212 seconds, including 18 lineage API tests. The tests use real temporary
  Git repositories, an in-process HTTP server, and a fake daemon spawner.
  `git diff --check` passed, and the final status contains only the three
  authorized paths.
- Status: self-tested, pending user acceptance. A real UI and daemon end-to-end
  run has not been performed. Rollback reference: baseline commit `0c59e1a`,
  the tracked-file diff, and the new untracked `tests/test_guided_lineage_api.py`.
  No commit or deployment has been made.

### Implementation record: 20261126-073955-m1-t5-lineage-e2e

- 2026-11-26, America/Los_Angeles; branch `baton/e33e97/m1-t5`, baseline
  `8aae5fd`. Scope: M1-T5's strict whitelist. Project LOG and its index are
  outside that whitelist, so this contract records the work.
- Added a cross-module test using the real HTTP server, engine, SQLite and Git.
  Local deterministic model subprocesses supply planning, task work and
  review; a test-only SQLite trigger checks the single-active-run invariant
  at each run insertion or status update. The two RFC acceptance criteria have
  named tests, including gate failure on an externally advanced base.
- The M1-R1 through M1-R4 review artifacts each report PASS and no blocking
  issues; their four suites passed 15 tests together. The specified
  `python -m unittest tests.test_lineage_e2e -v` passed six tests in 56.217 s.
  Core/config, CLI/MCP graph, presets and stdlib tests passed 35 tests;
  `--version` and `presets --validate` also passed.
- Full discovery in a temporary copy ran 873 tests in 462.985 s: one failure
  and five skips. Before the run, 407 tracked/current source files matched this
  worktree by SHA-256. Its Vite build used the runner config loader to avoid
  writing to the shared dependency junction. The only failure is the baseline
  `tests/test_web_fullstack.py:108` favicon assertion: the unchanged test
  expects three images while the unchanged committed icon has eight. An
  independent rerun reproduced it, and `LOG.md` L0005 records the mismatch.
  The test and asset are outside this task's whitelist. The temporary copy was
  removed; full output is at `%TEMP%/vibebaton-m1t5-full.log`.
- Status: self-tested, pending user acceptance; the full-suite acceptance gate
  remains blocked by the out-of-scope baseline failure. No backend wiring
  defect was found in these scenarios. The baseline commit and worktree diff
  are the rollback reference; no commit or deployment has been made.
