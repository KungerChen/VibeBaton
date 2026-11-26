# Guided session and workflow contract

The Guided server stores workspace session state, recommends a workflow from
local readiness, and validates a selected lineup before a Guided launch. Studio
integration is handled separately.

## Session document

`<workspace>/.baton/guided/session.json` is UTF-8 JSON. The default document is:

```json
{
  "schema_version": 1,
  "active_stage": "setup",
  "workspace_path": null,
  "brainstorm": {
    "messages": [],
    "checklist": [],
    "latest_rfc_draft": "",
    "selected_l0_model": null,
    "has_online_draft": false
  },
  "workflow": {
    "mode": null,
    "lineup": {"roles": {}, "model_overrides": {}},
    "preset": null,
    "panel_enabled": false,
    "launch_request_id": null
  },
  "active_run_id": null,
  "open_human_gate": null,
  "open_drawer": null
}
```

| Field | Type and meaning |
| --- | --- |
| `schema_version` | Positive integer; new documents use `1`. |
| `active_stage` | `"setup"`, `"blueprint"`, `"build"`, or `"signoff"`. |
| `workspace_path` | String or `null`: the selected workspace path. |
| `brainstorm.messages` | Ordered array of `{role: "user" \| "assistant", content: string}`. |
| `brainstorm.checklist` | Array of `{id, status, value}`; `id` is `what`, `who`, `scope`, `limits`, or `done`, `status` is `clear`, `assumed`, or `open`, and `value` is a string. |
| `brainstorm.latest_rfc_draft` | String: latest editable RFC draft, including an unconfirmed draft. |
| `brainstorm.selected_l0_model` | String or `null`: selected L0 model override, e.g. `provider:model@effort`. |
| `brainstorm.has_online_draft` | Boolean: an online-generated draft exists in this session. |
| `workflow.mode` | `"interactive"`, `"overnight"`, `"panel"`, or `null` while unselected. |
| `workflow.lineup.roles` | Object mapping role names to provider IDs. |
| `workflow.lineup.model_overrides` | Object mapping role names to `provider:model@effort` strings. |
| `workflow.preset` | Preset ID string or `null`. |
| `workflow.panel_enabled` | Boolean: the selected panel setting. |
| `workflow.launch_request_id` | String or `null`: launch idempotency key. Save it before launch and reuse it for retries of the same launch intent; see [lineage contract](lineage_contract.md#guided-http-lineage-contract). |
| `active_run_id` | String or `null`: the run currently shown in Guided mode. |
| `open_human_gate` | `null` or `{run_id: string, task_id: string \| null}`; `null` task ID permits a run-level gate. |
| `open_drawer` | `null` or `{run_id: string, task_id: string}` for the open task drawer. |

The session records UI state and draft data. When restoring, fetch the current
run and gate status before displaying actions; stored gate state does not
authorize a decision or launch. A panel launch uses the existing run API's
`mode: "panel"`. Do not put credential values in this document.
The repository's current `.gitignore` does not exclude `.baton/guided/`;
the session can contain conversation and draft text that Git may report as
untracked. Manage the workspace's ignore rules before committing session data.

Python interfaces, all relative to the workspace root:

```python
default_session() -> GuidedSession
load_session(repo_path: str | Path) -> GuidedSession
save_session(repo_path: str | Path, session: GuidedSession) -> None
reset_session(repo_path: str | Path) -> GuidedSession
```

`load_session` returns independent defaults for a missing file, invalid UTF-8,
invalid JSON, a non-object, or invalid known fields. It never repairs or writes
the file. Other filesystem errors propagate. Missing known fields receive their
defaults. Unknown object keys, including nested keys, survive load and save;
compatible documents with a later positive version retain that version. The
store does not migrate future versions or interpret unknown fields.

`save_session` validates known fields and fills missing known fields before
writing. Invalid known fields raise `ValueError`; non-JSON values fail
serialization. Both failures happen before the existing file is replaced.
It writes a complete temporary file in the destination directory, flushes and
syncs it, closes it, then calls `os.replace`. A failure before replacement
leaves the previous document intact. An abruptly terminated process can leave
an unused temporary file. The store does not serialize concurrent updates:
each replacement is atomic and the last completed replacement wins. File sync
does not promise directory-entry durability after power loss.

`reset_session` atomically writes and returns the default document; it does not
stop a run or modify its history. Normal save/reset filesystem errors propagate.

## Guide size

The live `guide` JSON block may include `size`:

```json
{"question": "Who uses it?", "options": ["My team"], "checklist": [], "size": "MeDiUm"}
```

After trimming whitespace and ignoring case, `small`, `medium`, and `large`
become their lowercase forms. Any other value, including `null` and non-strings,
becomes `None` (`null` in JSON) without failing the live turn. When `size` is
absent, the parsed guide retains exactly its original three fields; use
`guide.get("size")` to read the missing value as `None`. Offline and RFC-derived
guides likewise omit it. Existing `question`, `options`, and `checklist`
behavior is unchanged.

## Workflow recommendation interface

`src/vibebaton/workflow_recommend.py` defines these stdlib types:

```python
WorkflowLineup = {"roles": dict[str, str], "model_overrides": dict[str, str]}
ProviderReadiness(provider_id: str, kind: Literal["cli", "http"],
                  provider_ready: bool, credential_ready: bool)
ReadinessSnapshot(providers: tuple[ProviderReadiness, ...],
                  default_lineup: WorkflowLineup | None = None)
WorkflowRecommendation(mode: WorkflowMode, preset: str | None,
                       lineup: WorkflowLineup | None, size: ProjectSize | None,
                       reason_code: str, explanation_key: str, fallback: bool)
recommend_workflow(size: ProjectSize | None, readiness: ReadinessSnapshot, *,
                   previous_lineup: WorkflowLineup | None = None) -> WorkflowRecommendation
```

`ProjectSize` is `"small" | "medium" | "large"`; `WorkflowMode` is
`"interactive" | "overnight" | "panel"`. `default_lineup` can carry the
host-derived lineup from the existing CLI scan. `previous_lineup` carries the
prior role assignments and model overrides for consideration, without
modifying the supplied value. `provider_ready` records provider availability;
`credential_ready` records whether required authentication is available and is
true when no separate credential is required. A usable provider has both flags
true. The snapshot contains statuses and IDs, never credential values.

The recommendation contains an API run mode, preset ID, role/model lineup,
normalized input size, machine-readable reason code, UI translation key, and
whether a readiness-driven fallback was used. It also includes `size_changed`,
`explanation_codes`, and `substitutions`. `preset` or `lineup` can be `null`
when no selection is available; a missing lineup is not launch-ready.

## Guided HTTP contract

These routes use the server's currently selected workspace. A stored
`workspace_path` is session data and does not switch the server workspace.

| Method and route | Request | Success |
| --- | --- | --- |
| `GET /api/guided/session` | None. | `200 {"session": <session document>}`; missing or corrupt document returns defaults. |
| `PUT /api/guided/session` | `{"session": <partial session object>}`. | `200 {"session": <normalized saved document>}`. |
| `POST /api/guided/session/reset` | `{}`. | `200 {"session": <default document>}`. |
| `GET /api/guided/l0-models` | None. | `200 {"models": [{"provider", "model", "effort", "spec", "label"}], "auto_selected": string \| null}`. |

Session writes recursively merge object fields; arrays replace their previous
values. Within `workflow.lineup.roles` and `model_overrides`, entries merge,
an entry with `null` removes that entry, and `{}` clears the map. Unknown fields survive.
Invalid writes return `400 {"error": string}` and leave the stored document
unchanged. Once an online draft exists, a partial write cannot clear its flag
or replace the draft with an empty string; reset explicitly discards it.
Session I/O failures return `500` with `code: "SESSION_IO_ERROR"`. Within one
server process, updates to a workspace are serialized even across server
instances. Separate processes use atomic last-writer-wins replacement; clients
must reconcile stale writes across processes.

L0 options use the local model catalog and a fresh provider/credential scan.
`auto_selected` is the strongest catalogued ready L0 choice in
`provider:model@effort` form, or `null`. Readiness indicates local configuration
and authentication, not current remote quota or connectivity. Unregistered CLI
providers use the existing bounded provider probe; registered providers still
require their matching registry driver and its authentication check. For an
unregistered CLI the generic probe checks executable availability; the server
cannot infer authentication requirements that the provider does not declare.
For this route, `build_readiness_snapshot` supplies the authoritative readiness
snapshot for both the options and `auto_select_l0_model`; the latter selects
from that snapshot and the catalog without a second host scan.

### Brainstorm

`POST /api/brainstorm/chat` retains the existing request and response fields.
It accepts these additional optional request fields:

```json
{
  "requested_l0_model": "codex_sub:gpt-6.2-astra@xhigh",
  "latest_rfc_draft": "# An edited RFC...",
  "revision_context": {
    "prior_rfc": "# The prior RFC...",
    "requested_changes": "Add a health check.",
    "failure_context": "The old check failed."
  },
  "previous_lineup": {"roles": {}, "model_overrides": {}}
}
```

`revision` is an alias for `revision_context`; a top-level `failure_context`
requires a revision and overrides its nested value. The explicit requested
model takes precedence over the L0 entry in `model_overrides`. If neither is
supplied, a saved `selected_l0_model` is reused. `latest_rfc_draft` supplies an
edited draft; omitting it uses the saved draft. The full `messages` conversation
must still end with a user message.

Every completed turn saves the draft, conversation, checklist, selected L0
model when supplied, and online-draft flag, and sets the stage to `blueprint`
unless the session has advanced to a newer stage during the turn.
The model call and readiness scan do not hold the session lock. Unrelated
session changes made during the call are preserved, including a newer model
selection and a newer run stage. Before committing a completed turn and after a
successful readiness scan, the server checks whether the brainstorm content
changed or the session was reset. A stale turn returns `409` with
`code: "BRAINSTORM_SESSION_CHANGED"`; reload the session before retrying. A
reset invalidates in-flight turns in the same server process, including turns
started from an empty session. Separate processes retain the atomic
last-writer-wins behavior described above.
After an online draft, a failed live turn or explicit offline turn returns the
preserved draft with `error`, `retryable: true`, and `responding_model: null`.
Successful live turns report `requested_model` and the actual
`responding_model`; a legacy runner can return `null` for the latter. The
configured role model includes its `@effort` suffix when one was configured;
no suffix is invented when it was omitted. The
optional `guide.size` follows the parsing rule above. When
`blueprint.ready_to_launch` is true, the response includes `recommendation`
from a fresh readiness snapshot. It is advisory and does not overwrite the
session's workflow selection. A failed readiness scan returns `500` with
`code: "READINESS_UNAVAILABLE"`; the completed turn is already saved. Legacy
offline responses retain their existing shape until a recommendation is ready.
`POST /api/brainstorm/confirm` retains its existing contract.

### Launch and lineage

`POST /api/runs/start` accepts optional `lineup` and `preset` fields in addition
to the existing launch fields. A `lineup` contains a complete `roles` map and a
`model_overrides` map in the format above. Overrides must name the same provider
as their role. A structured `lineup` cannot be combined with the older
`role_providers` or `model_overrides` request fields. The server resolves and
pins the selected models, validates the lineup against fresh readiness, and
stores the effective selection, mode, preset, launch key and active run in the
session. Repeated requests with the same `launch_request_id` return the existing
run and do not start another daemon or replace a newer session stage.

Every `panel` launch checks the actual configured Synthesizer and panelists
before creating an RFC snapshot, run, or daemon. A rejection returns
`409 {"error": string, "code": "LAUNCH_PREFLIGHT", "codes": [string],
"fallback": <recommendation>}`; the fallback mode is `overnight`. A missing
Synthesizer credential includes `synthesizer_credentials_missing` in `codes`.
Legacy launches without a structured lineup retain their existing role
handling; panel preflight still applies.

A revision created by `finalize` or `request-changes` inherits its parent run's
captured explicit lineup and mode, revalidates them, and records the child as
the active run at stage `build`. For an older run without a captured lineup,
recorded model overrides are resolved against current configuration and
revalidated. A run with no recorded overrides inherits its mode and defaults;
unrecorded historical defaults cannot be revalidated as a historical lineup.
Successful rollback and approval set the active run's stage to `signoff`;
successful stop-and-replan sets it to `blueprint`. A failed action does not
advance the session. A session write failure after a run starts returns `500`
with its `run_id`; retry a keyed launch with the same key to restore the session.
For a revision, inspect the returned child `run_id` before taking another action.
