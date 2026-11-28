> Archived 2026-11-27: this was the active RFC (`.baton/00_RFC.md`) for Studio Workbench Phase 1, delivered in full; superseded by the Phase 2 RFC. Kept unchanged below this line.

# VibeBaton Studio Workbench, Phase 1: One Launch Path, Three-Act Shell & Lean Small-Task Flow

## Goals

Make the Studio open on one project workbench that moves through Blueprint, Build and Sign-Off, with a single idempotent launch path, honest status displays, and a two-role flow for small tasks.

1. **Lean small-task flow (engine)**: For runs the Guided page launches with size `small`, skip the L1 planning call and run "one model builds, one model reviews":
   - Synthesize the plan deterministically from the run's RFC snapshot: exactly one milestone with one task, assigned to `critical_executor`, no per-task reviewer, and the RFC's verification command(s) as the milestone `gate_commands`.
   - Keep the automated milestone gate, exactly one independent review (the existing milestone review), and the human final gate.
   - Escalate instead of guessing: when the RFC has no detectable verification command, or the user turns the lean flow off for this run, use the full flow unchanged.
   - Show on the launch card which flow this run will use, with a per-run switch back to the full flow.
   - Runs without a size (command line, legacy runs, resumed runs) behave exactly as today.
2. **One launch path**: Every real run starts through the Guided launch request with `launch_request_id`.
   - Add a "Paste RFC" fast lane to the Blueprint stage: paste, drop or edit the RFC text directly, reuse the existing readiness scoring from `RfcStep`, and reach launch in two clicks without replaying the chat.
   - The launch confirmation lists what will actually take effect: RFC title, role to tool/model/effort mapping, execution mode, and the flow (lean or full). Per-run overrides are labelled "this run only".
   - Budget is shown as the inherited project default with a link to where it is changed; no per-run budget override is added (the server has none).
   - Remove `StartRunModal` and its hand-written JSON override box once the fast lane covers its fields (`rfc_markdown`, `mode`, `model_overrides`). The three "Start Real Run" buttons become one entry into the workbench launch bar.
3. **Three-act shell**:
   - The Studio opens on the workbench by default (today `studioMode` defaults to `'pro'`).
   - The stage rail numbers only "1 Blueprint, 2 Build, 3 Sign-Off". The backend stage enum `setup | blueprint | build | signoff` and the session file format stay unchanged.
   - `setup` becomes a readiness capsule in the top bar (ready / partly ready / blocked, text plus icon) that expands the existing workspace and tool wizard only when something is missing. A ready workspace lands directly on Blueprint; a restored session returns to its own stage.
   - Readiness is independent of the stage: turning red mid-run never moves `active_stage` back; it only blocks launch, with the reason linking to the fix. Readiness is re-checked on workspace change, lineup change, manual refresh and right before launch.
   - The former Pro three-column view stays reachable from a secondary top-bar entry in this phase; it is not restructured here.
4. **Honest displays (two items)**:
   - Sign-Off: an empty gate list (`gates: []`) never shows "checks passed". Merge result and verification result are shown separately; verification has four states: passed, failed, not configured, not returned.
   - Cost: an invocation with no reported usage shows "not reported" instead of `$0.00`, and totals state how many invocations reported usage.

## Constraints

- Keep the Python core on the standard library only (Python 3.11+); `tests/test_stdlib_only.py` stays green.
- No change to the SQLite schema, the PlanDAG schema in `schemas.py`, the guided session file format, or the stage enum. Existing CLI commands, `baton.toml`, MCP tools and existing databases keep working.
- The engine does not consume workflow graphs or presets; the lean flow is selected by run size only.
- Lean-flow runs still enforce the path whitelist, worktree isolation, lineage columns and run-scoped RFC snapshots exactly as full-flow runs do.
- Every tool, model and effort shown or submitted goes through `model_catalog.normalize_spec`; no new code path may build a spec string without it.
- Keep `EN | 中文` key parity in `web/src/i18n/messages.ts`; EN copy stays ASCII; Guided copy uses plain words.
- Do not change `web/package-lock.json` unless a dependency change is unavoidable; none is expected.
- One verifiable goal per round; each round appends a LOG entry and an index line.

## Non-Goals

- Phase 2: run store extraction, read-only live relay graph, context drawer and bottom dock, handoff cards, evidence matrix.
- Phase 3: moving the Pro view into the Lab, splitting the two canvas hosts, hash routing, and deleting `studioMode` and `liveViewActive`.
- Phase 4: typography and status-colour tokens, the settings centre, and the Term Lens.
- Skipping the milestone review or the final gate for small tasks; changing the flow for medium or large runs.
- Per-run budget overrides, cost forecasts, and an always-on L0 copilot.
- Letting the engine execute canvas topology.

## Architecture & Deliverables

- **Milestone 1 - Lean small-task flow (backend)**:
  - `src/vibebaton/engine.py`: a deterministic single-task plan builder used in `_ensure_plan` when the run's `guided_launch_selection` event carries size `small` and the lean flow is enabled; an event recording which flow was chosen and why.
  - `src/vibebaton/web_server.py` and `src/vibebaton/workflow_recommend.py`: carry the per-run lean/full choice in the launch selection; report the chosen flow in the recommendation.
  - `tests/`: plan synthesis from an RFC snapshot; no planner call and no per-task review on a lean run; milestone gate and milestone review still run; fallback to the full flow when no verification command exists or the switch is off; unchanged behaviour without a size.
- **Milestone 2 - One launch path (frontend, small API additions only if needed)**:
  - `web/src/components/guided/GuidedBrainstormStep.tsx`, `GuidedLaunchBar.tsx`, a new paste-RFC entry reusing `web/src/components/inspector/wizard/RfcStep.tsx` scoring, `web/src/api/client.ts`, `web/src/i18n/messages.ts`.
  - Launch confirmation with effective values and the lean/full switch; removal of `web/src/components/inspector/StartRunModal.tsx` and its call sites (`HeaderBar.tsx`, `RightInspector.tsx`, `LiveRunPanel.tsx`), each replaced by an entry into the workbench launch bar.
- **Milestone 3 - Three-act shell and honest displays (frontend)**:
  - `web/src/lib/studioMode.ts` default, `web/src/components/guided/GuidedWorkbench.tsx` stage rail and readiness capsule, `GuidedSetupStep.tsx` as the on-demand wizard, `GuidedSignOffPanel.tsx` four-state verification, and cost displays in the run panels and battle report.
  - `vitest` coverage for the capsule states, stage restoration, the empty-gate case and the "not reported" cost case; production build.

## Verification & Acceptance Criteria

1. A Guided run launched as `small` with a verification command in its RFC makes no planning call, executes one task, runs the milestone gate and one review, and reaches the final gate; the run events state that the lean flow was used.
2. The same RFC launched with the lean switch off, or an RFC with no verification command, runs the full flow; a run started from the command line plans exactly as before this change.
3. Journey 2 passes in a browser on a ready workspace: the first screen accepts a pasted RFC, the launch confirmation matches what the run actually uses, and a simulated launch timeout followed by a retry yields exactly one run.
4. `StartRunModal` no longer exists in the source tree, and every former "Start Real Run" button leads to the workbench launch bar.
5. A ready workspace opens on Blueprint with a three-step stage rail; an unready one shows the capsule reason and opens the wizard; refreshing during Build or Sign-Off returns to the same run and stage.
6. A Sign-Off whose re-integration returned no gates shows "no gate records" in a neutral colour, never a green "checks passed".
7. An invocation without usage data is displayed as "not reported", and the total shows the reporting coverage.
8. All Python tests and all Studio tests pass, and the production build succeeds.

```bash
python -m unittest discover -s tests
npm --prefix web test
npm --prefix web run build
```

## Roadmap After This RFC (information only)

This section is not part of the scope above. Planners and executors must not plan, build or verify anything listed here. Each phase gets its own RFC, drafted from `docs/STUDIO_MASTER_PLAN.md` sections 9 and 10 and confirmed by the user, after the previous phase is accepted. Before a new RFC replaces this file, archive this one under `docs/`.

| Phase | Deliverables | Release gate | Must be settled first |
| --- | --- | --- | --- |
| 2 - Build and Sign-Off main stage | One run store for the SSE snapshot, selected run and run controls; read-only live relay graph; context drawer and bottom dock; every `LiveRunPanel` field reachable there; handoff cards; evidence matrix of acceptance criteria against gate results | Journey 1 (beginner loop) passes; the object-binding part of journey 4 passes | Add `artifact_key` to the `role_invoked` event payload so a handoff card can point at its prompt and output files (additive); verify master plan assumptions 1 and 2 |
| 3 - Lab isolation and old shell removal | Move the Pro three-column view into the Lab; separate live and Lab canvas hosts; hash routing for refresh, back and deep links; stop the Lab from writing `baton.toml`; relay swimlanes, lineage time machine, decision inbox, changed-file lookup in the matrix; last step: delete `studioMode`, `liveViewActive` and the three rollback buttons | All four journeys pass; each of the three rollback paths is verified | Who produces the criterion-to-gate binding (model proposes and a person confirms, or a person specifies it) through a separate SPEC discussion; verify assumptions 3 and 4 |
| 4 - Tokens, settings centre and Term Lens | Five type sizes, three weights and exclusive status colours on both sides; one settings centre with "project default" and "this run only" scopes; Term Lens with explicit bindings, a controlled matcher and a single viewport popover | Keyboard, touch and narrow-screen walkthroughs; no font size below 11 px in the code | Default Term Lens state for new users; colour of primary and selected controls; verify assumption 8 |
| Later | `Ctrl+K` navigation palette, then the overnight briefing, hard-limit circuit breaker, and the full panel-consultation trace | Each has its own precondition in master plan section 8.3 | Reading cursor and history backfill for events (assumption 6); a verified metering source for the circuit breaker |

Dropped for good (master plan section 8.4): pre-launch cost forecasts and an always-on L0 copilot.
