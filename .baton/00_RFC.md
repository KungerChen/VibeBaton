# VibeBaton Studio Workbench, Phase 2: Build and Sign-Off Main Stage

## Goals

Make the Build and Sign-Off stages of the workbench the place where a run is watched, steered and judged: one run store, a read-only live relay graph with a context drawer and a bottom dock, handoff cards, and an evidence matrix that shows recorded facts only.

1. **One run store**: The live snapshot stream, the selected run and the run controls live in one place.
   - Move the SSE snapshot, the selected run, the reconnect state and the run controls (pause, resume, stop, resolve) out of `AppContent` into one store module that the workbench and the Pro view both read.
   - `LiveRunPanel` stops opening an event stream of its own; its run data comes from the store.
   - New events change the viewed run only while "follow the latest run" is on. It is on for a run the user has just launched and turns off when the user opens an older run. While an older run is viewed, the workbench shows that run's short ID and a "back to the current run" control.
2. **Recorded evidence (backend, additive)**: The Studio can only show what the engine wrote down, so two facts are recorded and three read-only views are added.
   - Gate receipts: every command a gate suite runs (task check, milestone gate, merge gate, re-integration at final approval) is recorded as a run event with its scope, target, command, exit code, duration and a bounded tail of its output. Runs recorded before this phase have no receipts.
   - The `role_invoked` event already carries `artifact_key` (delivered before this RFC); a read-only endpoint returns the prompt and the output behind such a key.
   - A handoff and a receipt are identified by the row id of their event, which run snapshots already return.
   - A read-only endpoint lists the handoffs of a run derived from recorded events; another returns the evidence table of a run (the acceptance criteria of its RFC snapshot against gate receipts and changed files).
3. **Build main stage**:
   - A read-only live relay graph is the main stage of Build. Selecting a node or an edge only changes what the drawer shows; nothing in Build edits the graph or leaves the live view.
   - An edge backed by recorded handoff events is drawn differently from an edge that only follows the plan layout. A handoff without a record stays "unknown".
   - Handoff card, opened from an edge: the holder before and after, the deliverable with its prompt and output, changed files, gate command and exit code, review verdict, takeover status and blocking reason. Each value is shown as recorded or as "unknown".
   - Context drawer with one owner at a time, in this order: a pending decision, the selected object, the run overview. Its upper part says in plain words what happened and what can be done now, and its actions name their target (for example "Reply to task T3", "Approve and merge into main"). Its lower part holds technical details, collapsed by default; only the user's own expand and collapse is remembered, per panel type.
   - The drawer and the dock live inside the workbench body, below the row that holds the readiness capsule. The on-demand workspace and tools wizard still opens above the stage and never replaces the graph.
   - Bottom dock in Build and Sign-Off only: collapsed, it is one line with the latest event; expanded, it has Timeline, Terminal and Gates tabs. The timeline states that it covers the latest 200 events.
   - Every field and control of `LiveRunPanel` is reachable from the drawer or the dock: run status and elapsed time, stage timing, model runtime, billing with "not reported" and coverage, the task list and task details, the event log, pause, resume and stop, human decisions, the battle report, pricing and run history.
4. **Sign-Off evidence matrix (P0)**:
   - One row per numbered acceptance criterion of the run's RFC snapshot, with one evidence cell built from this run's gate receipts.
   - The cell has exactly three states and is never inferred. "Gate receipt": the criterion's own text cites the command of a receipt verbatim; the cell shows the recorded pass or fail and opens the command and its output. "Changed files only": the criterion cites the path of a file this run changed and has no receipt; neutral colour, not counted as passed. "Not linked": neutral colour.
   - The summary counts receipt-backed results only. Receipts that no criterion cites are listed next to the matrix as run-level receipts, so no result is hidden and none is attributed by guesswork.
5. **Release journeys**: journey 1 (beginner loop) and the object-binding part of journey 4 of `docs/STUDIO_MASTER_PLAN.md` section 10 pass in a browser.

## Constraints

- Keep the Python core on the standard library only (Python 3.11+); `tests/test_stdlib_only.py` stays green.
- No change to the SQLite schema, the PlanDAG schema in `schemas.py`, the guided session file format, or the stage enum. New facts are written as run events in the existing `events` table and derived on read. Existing CLI commands, `baton.toml`, MCP tools and existing databases keep working; a run recorded before this phase opens without errors and shows missing evidence as missing.
- The engine does not consume workflow graphs or presets. The relay graph is a projection of the plan and of recorded events; a relation that no event backs is never drawn as an actual handoff.
- Honest displays: no receipt means no pass; an empty gate list never shows "checks passed"; unreported cost shows "not reported"; an unrecorded handoff stays "unknown"; a view limited to the latest 200 events says so.
- The evidence matrix never infers a link or a pass: no similarity matching, no model call, and changed files never count as passed. A link exists only when the criterion's own text contains the command or the path verbatim; a command that is a single word counts only inside an inline code span, so ordinary prose cannot cite it by accident.
- Artifact reads are path-safe: an artifact is addressed by an `artifact_key` recorded for that run, never by a client-supplied path, and every response is size-bounded.
- Every tool, model and effort shown goes through `model_catalog.normalize_spec`; no new code path may build a spec string without it.
- Keep `studioMode`, `liveViewActive` and the three rollback buttons; the Pro view keeps working as it does today.
- Keep `EN | 中文` key parity in `web/src/i18n/messages.ts`; EN copy stays ASCII; Guided copy uses plain words.
- Do not change `web/package-lock.json`; the relay graph reuses `@xyflow/react`, which the project already depends on.
- One verifiable goal per round; each round appends a LOG entry and an index line.

## Non-Goals

- Phase 3: moving the Pro three-column view into the Lab, separate live and Lab canvas hosts, hash routing, stopping the Lab from writing `baton.toml`, relay swimlanes, the lineage time machine, the decision inbox, changed-file lookup in the matrix, and deleting `studioMode`, `liveViewActive` and the three rollback buttons.
- Phase 4: typography and status-colour tokens, the settings centre, and the Term Lens.
- Later work: the `Ctrl+K` palette, the overnight briefing, the hard-limit circuit breaker, and the full panel-consultation trace.
- Deciding or building how acceptance criteria get bound to gates (proposed by a model and confirmed by a person, or specified by a person). This phase shows only links that are literally written in the RFC. Starting a rework from selected matrix rows is left out for the same reason.
- Rewording or replacing the three rollback buttons; a live base-SHA drift check before approval.
- Reading events beyond the latest 200, or storing a reading cursor.
- Per-run budget overrides, cost forecasts, and an always-on L0 copilot.
- Letting the engine execute canvas topology.

## Architecture & Deliverables

- **Milestone 1 - Run store and recorded evidence**:
  - `src/vibebaton/engine.py` and the final-approval path in `src/vibebaton/web_server.py`: one `gate_receipt` event per gate command, with payload `scope` (`task`, `milestone`, `merge` or `final`), `target_id`, `command`, `exit_code`, `passed`, `duration_sec` and `output_tail`.
  - A small pure module (for example `src/vibebaton/evidence.py`) that derives handoffs and the evidence table from events, the plan and the RFC snapshot; `src/vibebaton/web_server.py` routes `GET /api/runs/{run_id}/handoffs`, `GET /api/runs/{run_id}/artifacts/{artifact_key}` and `GET /api/runs/{run_id}/evidence`.
  - `web/src/state/runStore.ts` (new) holding the snapshot stream, the selected run, follow-latest and the run controls; `web/src/App.tsx` reads it and passes it on, and `web/src/components/inspector/LiveRunPanel.tsx` loses its own stream; typed calls for the three endpoints in `web/src/api/client.ts`.
  - `tests/`: receipts for passing and failing commands at each scope, a run without receipts, recorded and unknown handoffs, artifact read safety, the three evidence states. `vitest`: follow-latest, opening an older run, reconnect, and unchanged Pro view behaviour.
- **Milestone 2 - Relay graph, context drawer and handoff cards**:
  - `web/src/components/guided/`: the read-only relay graph for Build (the existing canvas renderer with editing off and its own selection state), the context drawer that takes over from `NodeDetailDrawer` and `GuidedDecisionDrawer`, and the handoff card; wiring in `GuidedWorkbench.tsx`; copy in `web/src/i18n/messages.ts`.
  - `vitest`: selection changes only the drawer, recorded and layout edges differ, an unknown handoff says so, drawer owner order, action labels name their target, remembered expand state.
- **Milestone 3 - Bottom dock, `LiveRunPanel` field migration and run following**:
  - The bottom dock with Timeline, Terminal and Gates; the remaining `LiveRunPanel` fields and controls placed in the drawer and the dock; the viewed-run indicator and "back to the current run".
  - `vitest`: an inventory of `LiveRunPanel` fields mapped to their new place and asserted, dock visibility per stage, and decisions reaching the named run and task while another run emits events.
- **Milestone 4 - Evidence matrix and release journeys**:
  - `web/src/components/guided/GuidedSignOffPanel.tsx`: the evidence matrix, its summary and the run-level receipts list.
  - `vitest` for the three states and the summary; browser walkthroughs of journey 1 and of the object-binding part of journey 4; README facts brought up to date.

## Verification & Acceptance Criteria

1. After a run, each gate command that the engine or the final approval executed has one `gate_receipt` event with its scope, target, command and exit code; a failing command's receipt says failed; a run recorded before this phase shows no receipts and no pass.
2. The workbench and the Pro view show the same run from one store; `LiveRunPanel` opens no event stream of its own; selecting, pausing, resuming and stopping a run behave as before.
3. In Build, selecting any node or edge changes only the drawer; no interaction in Build edits the graph or leaves the live view.
4. An edge with recorded handoff events looks different from an edge derived only from the plan; the card of an unrecorded handoff says "unknown"; the card of a recorded handoff shows the holder before and after, the deliverable with its prompt and output, changed files, the gate command with its exit code, the review verdict and the takeover status.
5. Every `LiveRunPanel` field and control named in the inventory test is reachable in the drawer or the dock; pause, resume, stop and human decisions work there and name their target.
6. The dock is absent in Blueprint, is one line with the latest event when collapsed, and offers Timeline, Terminal and Gates when expanded.
7. While an older run is viewed, events and a pending decision from another run do not change the viewed run; the workbench shows the viewed run's short ID and a way back to the current run; each decision reaches the run and task named on its control.
8. In Sign-Off, every acceptance criterion of the run's RFC is a row with one of the three states; a criterion with only changed files is neutral and not counted as passed; a criterion without evidence says "not linked"; no row shows passed without a receipt whose exit code is 0.
9. Journey 1 passes in a browser inside one shell: start from one sentence, launch, answer one human decision during Build, reach Sign-Off, request changes, and sign off the child revision; the parent run stays reachable read-only and an empty gate list never shows passed.
10. All Python tests and all Studio tests pass, the type check is clean, and the production build succeeds.

```bash
python -m unittest discover -s tests
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
```

Browser walkthroughs run against the real server and daemon in a throwaway repository with its user-level state kept apart; the model CLIs may be stand-ins, so no paid model run is needed to accept this phase.

## Roadmap After This RFC (information only)

This section is not part of the scope above. Planners and executors must not plan, build or verify anything listed here. Each phase gets its own RFC, drafted from `docs/STUDIO_MASTER_PLAN.md` sections 9 and 10, after the previous phase is accepted. Before a new RFC replaces this file, archive this one under `docs/`.

| Phase | Deliverables | Release gate | Must be settled first |
| --- | --- | --- | --- |
| 3 - Lab isolation and old shell removal | Move the Pro three-column view into the Lab; separate live and Lab canvas hosts; hash routing for refresh, back and deep links; stop the Lab from writing `baton.toml`; relay swimlanes, lineage time machine, decision inbox, changed-file lookup in the matrix; last step: delete `studioMode`, `liveViewActive` and the three rollback buttons | All four journeys pass; each of the three rollback paths is verified | Who produces the criterion-to-gate binding (a model proposes and a person confirms, or a person specifies it), decided by the user in a separate SPEC discussion; verify master plan assumptions 3 and 4 |
| 4 - Tokens, settings centre and Term Lens | Five type sizes, three weights and exclusive status colours on both sides; one settings centre with "project default" and "this run only" scopes; Term Lens with explicit bindings, a controlled matcher and a single viewport popover | Keyboard, touch and narrow-screen walkthroughs; no font size below 11 px in the code | Default Term Lens state for new users; colour of primary and selected controls; verify assumption 8 |
| Later | `Ctrl+K` navigation palette, then the overnight briefing, hard-limit circuit breaker, and the full panel-consultation trace | Each has its own precondition in master plan section 8.3 | Reading cursor and history backfill for events (assumption 6); a verified metering source for the circuit breaker |

Dropped for good (master plan section 8.4): pre-launch cost forecasts and an always-on L0 copilot.
