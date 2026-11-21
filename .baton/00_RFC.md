# Master RFC: VibeBaton Stage 1 (`v0.2-engine`) — Declarative Node-Graph Workflow Engine

## 1. Goal

Upgrade VibeBaton from `v0.1-seed` (`__version__ = "0.1.0-seed"`) to **`v0.2-engine`** (`__version__ = "0.2.0-dev"`): a declarative **Node-Graph Workflow Engine** supporting all 7 atomic building-block node types, 4 official `.baton.json` presets, CLI/MCP graph validation and deterministic dry-run simulation, and zero external runtime dependencies (Python 3.11+ stdlib only).

---

## 2. Constraints & Non-Goals

### Hard Constraints
- **Zero External Dependencies**: Pure Python 3.11+ standard library only (`dataclasses`, `enum`, `asyncio`, `json`, `pathlib`, `unittest`). Do NOT add third-party packages to `pyproject.toml`.
- **100% Backward Compatibility**: Preserve all existing CLI subcommands (`init`, `doctor`, `run`, `daemon`, `status`, `resolve`, `report`, `mcp`, `promote-seed`) and all 7 existing MCP tools (`baton_health`, `baton_start`, `baton_status`, `baton_logs`, `baton_resolve`, `baton_control`, `baton_final_package`).
- **Windows & Self-Hosting Compatibility**: All tests must pass cleanly on Windows under `python -m unittest discover -s tests -v`.
- **Update Existing E2E Assertion**: Note that `tests/test_e2e_pipeline.py` (line 305) currently asserts `self.assertEqual(len(tool_names), 7)` on `tools/list`. When adding new MCP tools (`baton_list_presets`, `baton_validate_graph`), update that assertion accordingly (e.g. `>= 9` or exact expected count and check the new tool names) so the full test suite remains green.

### Non-Goals (Out of Scope for Stage 1)
- Do **NOT** build Stage 2 React Flow web canvas / FastAPI web UI / frontend assets in this stage. Stage 1 focuses solely on the Python node-graph schema, async execution engine, mock simulation, 4 presets, CLI, and MCP integration.

---

## 3. Architecture & Module Deliverables

To maximize parallel execution with Contract-First safety, structure the work into foundation contracts (`critical`) followed by presets/integrations/tests (`routine` + final integration):

### Deliverable 1 (`critical`): `src/vibebaton/graph_schema.py`
Strongly-typed declarative workflow graph schema & validator matching the `.baton.json` format (`schema_version`, `id`, `name`, `difficulty`, `description`, `recommended_for`, `nodes`, `edges`):
- `NodeType` (`str, Enum`) with all **7 atomic node types**:
  1. `planner_node`
  2. `router_node`
  3. `worker_node`
  4. `gate_node`
  5. `reviewer_node`
  6. `merge_node`
  7. `human_gate_node`
- Dataclasses:
  - `NodeSpec(id: str, type: NodeType, label: str, role: str | None = None, position: dict[str, float] | None = None, config: dict[str, Any] = field(default_factory=dict))`
  - `EdgeSpec(id: str, source: str, target: str, source_handle: str = "out", target_handle: str = "in", max_loops: int | None = None, condition: str | None = None)`
  - `WorkflowGraph(schema_version: str, id: str, name: str, nodes: list[NodeSpec], edges: list[EdgeSpec], difficulty: str = "pro", description: str = "", recommended_for: list[str] = field(default_factory=list))`
  - `GraphValidationResult(valid: bool, errors: list[str], warnings: list[str], entry_nodes: list[str], has_cycles: bool)`
- Methods & Functions:
  - `WorkflowGraph.from_dict(data: dict[str, Any]) -> WorkflowGraph` (accepts both `sourceHandle`/`targetHandle` camelCase from `.baton.json` and snake_case, raising a clear `ValueError` or `SchemaValidationError` on invalid node types/missing required fields).
  - `WorkflowGraph.to_dict() -> dict[str, Any]` (round-trips cleanly to `.baton.json` camelCase keys).
  - `validate_graph(graph: WorkflowGraph) -> GraphValidationResult`:
    - Checks non-empty `nodes` and unique `node.id` values and unique `edge.id` values.
    - Checks every `edge.source` and `edge.target` references an existing `node.id`.
    - Identifies entry nodes (nodes with in-degree 0 ignoring loop/back-edges, or all nodes with 0 incoming non-`fix`/non-loop edges; warns or errors if unreachable nodes exist from entry nodes).
    - Detects cycles: allows controlled feedback loops (e.g., `gate_node` `fail` -> `worker_node` `fix`, or `reviewer_node` `minor_fix` -> `worker_node` `fix`), **provided** every cycle contains at least one edge with `max_loops >= 1` (or a node config with `max_loops >= 1`). Unbounded cycles without `max_loops >= 1` MUST fail validation with a clear error.

### Deliverable 2 (`critical`): `src/vibebaton/graph_engine.py`
Generic async node-graph execution engine + deterministic mock simulator (for Stage 2 zero-config preview):
- `NodeExecutionResult` dataclass (`outcome: str` e.g. `"out"`, `"pass"`, `"fail"`, `"minor_fix"`, `"escalate"`, `"critical"`, `"routine"`, `"rfc"`, `"dag"`; `payload: dict[str, Any]`; `message: str = ""`).
- `GraphTraceEvent` dataclass (`seq: int`, `timestamp: float`, `kind: str` in `{"node_started", "node_completed", "node_failed", "edge_traversed", "loop_limit_reached", "graph_completed", "graph_halted"}`, `node_id: str | None`, `edge_id: str | None`, `outcome: str | None`, `message: str`).
- `NodeHandler` protocol (`async def handle(self, node: NodeSpec, context: dict[str, Any]) -> NodeExecutionResult`).
- `GraphExecutionEngine`:
  - Validates the graph before execution (raises `ValueError` if `validate_graph(graph).valid` is False).
  - Registry mapping `NodeType` (or node ID) -> `NodeHandler`.
  - Traverses outgoing edges matching `source_handle == result.outcome` (with clean fallback if `source_handle == "out"` or wildcard when appropriate).
  - Tracks per-edge traversal count and enforces `edge.max_loops` (or target/source node `config.get("max_loops")`): when an edge exceeds `max_loops`, emits `loop_limit_reached` and safely halts/circuits rather than looping infinitely.
  - Returns a `GraphRunResult(status: str, visited_nodes: list[str], trace: list[GraphTraceEvent], context: dict[str, Any])`.
- `MockSimulationHandlers` + `simulate_graph(graph: WorkflowGraph, scenario: str = "happy_path") -> GraphRunResult`:
  - Supports 3 deterministic scenarios without calling external CLIs or network:
    - `"happy_path"`: clean pass through planning, routing, workers, gate pass, reviewer pass, merge, and human gate.
    - `"gate_retry"`: `gate_node` returns `"fail"` on attempt 1 (triggers loop back to worker `fix`), then `"pass"` on attempt 2.
    - `"escalate"`: `reviewer_node` (micro review) returns `"escalate"` (or triggers `"minor_fix"` loop then `"escalate"`), routing to specialist/critical path before merge and milestone review.

### Deliverable 3 (`routine` / Presets): `src/vibebaton/presets.py` + 4 Official `.baton.json` Presets
1. Update `presets/flagship_4tier.baton.json`:
   - Align model names to verified defaults: `fable@high`, `opus@high`, `gpt-6.2-astra@xhigh`, `gpt-6.2-sol@max`, `deepseek-v4.1-flash@max` (keep `gemini-4-neon-high` for `host_native`).
   - Ensure all nodes/edges pass `validate_graph()` cleanly (every loop edge `e6`, `e8` has `max_loops >= 1`).
2. Update `presets/starter_2tier.baton.json`:
   - Align `dsh_opencode` model names to `deepseek-v4.1-flash@max` and ensure it passes `validate_graph()`.
3. Create `presets/solo_coder_3tier.baton.json`:
   - Balanced 3-tier solo developer workflow (`difficulty: "intermediate"`): `planner_node` (`fable@high` or `gpt-6.2-sol@max`) -> `worker_node` (`deepseek-v4.1-flash@max`) -> `gate_node` (with `fail` retry loop `max_loops: 2`) -> `reviewer_node` (`gpt-6.2-astra@xhigh`) -> `merge_node` -> `human_gate_node`. Passes `validate_graph()`.
4. Create `presets/review_only_audit.baton.json`:
   - Read-only code audit & verification pipeline (`difficulty: "beginner"`): `gate_node` -> `reviewer_node` (micro/security review with `gpt-6.2-astra@xhigh`) -> `reviewer_node` (architecture review with `opus@high`) -> `human_gate_node`. No code-writing `worker_node`. Passes `validate_graph()`.
5. Implement `src/vibebaton/presets.py`:
   - `PresetSummary` dataclass (`id`, `name`, `difficulty`, `description`, `recommended_for`, `path`, `node_count`, `edge_count`).
   - `presets_dir() -> Path`
   - `list_presets(directory: Path | None = None) -> list[PresetSummary]`
   - `load_preset(id_or_path: str | Path, directory: Path | None = None) -> WorkflowGraph`
   - `validate_all_presets(directory: Path | None = None) -> dict[str, GraphValidationResult]`

### Deliverable 4 (CLI, MCP, Version Bump & Integration):
- Bump `src/vibebaton/__init__.py` `__version__` to `"0.2.0-dev"`.
- Update `src/vibebaton/cli.py`:
  - Add `baton presets [--validate] [--json]`: lists all built-in presets; with `--validate`, validates every preset and exits `1` if any fails, `0` if all pass.
  - Add `baton graph validate <file> [--json]` and `baton graph simulate <file> [--scenario happy_path|gate_retry|escalate] [--json]`: validates or dry-run simulates any `.baton.json` file (or preset ID).
- Update `src/vibebaton/mcp_server.py`:
  - Add `baton_list_presets` (lists preset summaries + validation status).
  - Add `baton_validate_graph` (takes `graph_path` or `graph_json` and returns `GraphValidationResult` + optional simulation trace if `simulate_scenario` is provided).
  - Update `tests/test_e2e_pipeline.py` line 305 tool count assertion to match the updated tool count (`9`) and assert presence of `baton_list_presets` and `baton_validate_graph`.

### Deliverable 5 (Comprehensive Automated Tests):
- `tests/test_graph_schema.py`: unit tests for all 7 `NodeType`s, `from_dict`/`to_dict` round-trip, missing node/edge error handling, cycle-with-`max_loops` allowed vs unbounded-cycle rejected, unreachable-node detection.
- `tests/test_graph_engine.py`: async execution tests for `GraphExecutionEngine`, loop limit circuit breaking (`loop_limit_reached`), and deterministic `simulate_graph()` across `"happy_path"`, `"gate_retry"`, and `"escalate"` scenarios.
- `tests/test_presets.py`: tests `list_presets()` (4 presets), `validate_all_presets()` (all valid), `load_preset()`, CLI `presets --validate` & `graph simulate`, and MCP `baton_list_presets` / `baton_validate_graph`.

---

## 4. Acceptance Criteria (Verifiable Mechanical Gates)

- [ ] `python -m unittest discover -s tests -v` exits `0` with all existing 6 tests and all new Stage 1 tests passing.
- [ ] `python -m vibebaton presets --validate` exits `0` and validates all 4 official `.baton.json` presets (`flagship_4tier`, `starter_2tier`, `solo_coder_3tier`, `review_only_audit`).
- [ ] `python -m vibebaton graph simulate presets/flagship_4tier.baton.json --scenario escalate` exits `0` and outputs a complete trace covering escalation to specialist, merge, milestone review, and final human gate.
- [ ] Zero new external runtime dependencies added to `pyproject.toml`.
- [ ] All existing CLI subcommands (`init`, `doctor`, `run`, `daemon`, `status`, `resolve`, `report`, `mcp`, `promote-seed`) and 7 core MCP tools remain 100% intact.
