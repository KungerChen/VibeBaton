import { describe, expect, test } from 'vitest';
import {
  EMBEDDED_PRESETS,
  findPreset,
  flagship_4tier,
  presetToItem,
  review_only_audit,
  solo_coder_3tier,
  starter_2tier,
} from '../data/presets';
import { SCENARIOS } from '../types/graph';
import type { Scenario, WorkflowGraph } from '../types/graph';
import customGraphsFixture from './__fixtures__/custom_graphs.json';
import pythonParityFixture from './__fixtures__/python_parity.json';
import { simulateGraph, validateGraph } from './localSimulator';

const pythonParity: Record<string, Record<Scenario, { status: string; visited_nodes: string[] }>> = pythonParityFixture;
const customGraphs = customGraphsFixture as Record<keyof typeof customGraphsFixture, WorkflowGraph>;
const { worker_and_gate: workerAndGate, reviewer_routes: reviewerRoutes, merge_in_loop: mergeInLoop } = customGraphs;

describe.each([...EMBEDDED_PRESETS, ...Object.values(customGraphs)])('$id', (graph) => {
  test('validates', () => {
    expect(validateGraph(graph)).toMatchObject({ valid: true, errors: [] });
  });

  test.each(SCENARIOS)('%s matches the Python fixture', (scenario) => {
    const result = simulateGraph(graph, scenario);
    const expected = pythonParity[graph.id][scenario];
    expect(result.status).toBe(expected.status);
    expect(result.visited_nodes).toEqual(expected.visited_nodes);

    const nodes = new Set(graph.nodes.map((node) => node.id));
    const edges = new Set(graph.edges.map((edge) => edge.id));
    expect(result.trace.length).toBeGreaterThan(0);
    for (const [index, event] of result.trace.entries()) {
      expect(event.seq).toBe(index + 1);
      expect(event.timestamp).toBe(event.seq * 0.01);
      if (event.node_id !== null) expect(nodes.has(event.node_id)).toBe(true);
      if (event.edge_id !== null) expect(edges.has(event.edge_id)).toBe(true);
    }
  });
});

test('exposes the embedded presets and their validated summaries', () => {
  expect(EMBEDDED_PRESETS).toEqual([flagship_4tier, solo_coder_3tier, starter_2tier, review_only_audit]);
  expect(findPreset('starter_2tier')).toBe(starter_2tier);
  expect(findPreset('unknown')).toBeUndefined();
  expect(presetToItem(starter_2tier)).toEqual({
    id: starter_2tier.id,
    name: starter_2tier.name,
    difficulty: starter_2tier.difficulty,
    description: starter_2tier.description,
    recommended_for: starter_2tier.recommended_for,
    node_count: 4,
    edge_count: 4,
    valid: true,
    errors: [],
    warnings: [],
    graph: starter_2tier,
  });
});

// Golden example from graph_engine.py. The test gate can retry the worker twice.
test('the worker retries once before approval in gate_retry', () => {
  const result = simulateGraph(workerAndGate, 'gate_retry');

  expect(result.status).toBe('completed');
  expect(result.visited_nodes).toEqual(['worker', 'gate', 'worker', 'gate', 'approval']);
  expect(result.trace.filter(({ kind }) => kind === 'edge_traversed').map(({ edge_id }) => edge_id))
    .toEqual(['test', 'retry', 'test', 'passed']);
  expect(result.trace.filter(({ kind, node_id }) => kind === 'node_completed' && node_id === 'gate')
    .map(({ outcome }) => outcome)).toEqual(['fail', 'pass']);
  expect(result.trace.at(-1)?.kind).toBe('graph_completed');
  expect(simulateGraph(workerAndGate, 'gate_retry')).toEqual(result);
});

test('reports a two-node cycle without a positive edge limit', () => {
  const graph: WorkflowGraph = {
    ...workerAndGate,
    nodes: workerAndGate.nodes.slice(0, 2),
    edges: [
      { id: 'test', source: 'worker', target: 'gate' },
      { id: 'retry', source: 'gate', target: 'worker', sourceHandle: 'fail' },
    ],
  };
  const validation = validateGraph(graph);
  expect(validation).toMatchObject({ valid: false, has_cycles: true });
  expect(validation.errors).toContain('Unbounded cycle without max_loops >= 1: worker -> gate -> worker');
  expect(simulateGraph(graph, 'happy_path')).toMatchObject({ status: 'failed', visited_nodes: [] });

  // A bounded parallel edge leaves the original unbounded cycle intact.
  const bypass = { ...graph, edges: [...graph.edges, { ...graph.edges[1], id: 'bounded', max_loops: 1 }] };
  expect(validateGraph(bypass).valid).toBe(false);
});

test('validates JSON shape and reports invalid references', () => {
  const { schema_version, id, nodes, edges } = workerAndGate;
  const missingName = { schema_version, id, nodes, edges };
  expect(validateGraph(missingName as unknown as WorkflowGraph).errors)
    .toEqual(["Workflow graph is missing required field 'name'"]);
  const unknownType = { ...workerAndGate, nodes: [{ id: 'worker', type: 'unknown', label: 'Worker' }] };
  expect(validateGraph(unknownType as unknown as WorkflowGraph).errors)
    .toEqual(["Unknown node type 'unknown' at nodes[0].type"]);

  const graph: WorkflowGraph = {
    ...workerAndGate,
    nodes: [...workerAndGate.nodes, workerAndGate.nodes[0]],
    edges: [...workerAndGate.edges, { id: 'test', source: 'missing-source', target: 'missing-target' }],
  };
  expect(validateGraph(graph).errors).toEqual([
    "Duplicate node id 'worker'",
    "Duplicate edge id 'test'",
    "Edge 'test' has dangling source 'missing-source'",
    "Edge 'test' has dangling target 'missing-target'",
  ]);
});

test('entry detection ignores feedback regardless of node order', () => {
  expect(validateGraph(starter_2tier).entry_nodes).toEqual(['plan']);
  expect(validateGraph({ ...workerAndGate, nodes: [...workerAndGate.nodes].reverse() }))
    .toMatchObject({ valid: true, has_cycles: true, entry_nodes: ['worker'] });
});

test('warns about unreachable nodes', () => {
  const graph: WorkflowGraph = {
    ...workerAndGate,
    nodes: [...workerAndGate.nodes, { id: 'orphan', type: 'merge_node', label: 'Orphan' }],
    edges: [...workerAndGate.edges, { id: 'orphan-loop', source: 'orphan', target: 'orphan' }],
  };
  expect(validateGraph(graph).warnings).toEqual(["Unreachable node 'orphan'"]);
  expect(presetToItem(solo_coder_3tier).warnings).toEqual([]);
});

test('happy_path joins the flagship branches once after both inputs arrive', () => {
  const { trace, visited_nodes } = simulateGraph(flagship_4tier, 'happy_path');
  const starts = trace.filter(({ kind, node_id }) => kind === 'node_started' && node_id === 'git_merge');
  const inputs = flagship_4tier.edges.filter((edge) => edge.target === 'git_merge');

  expect(starts).toHaveLength(1);
  for (const edge of inputs) {
    const arrived = trace.find((event) => event.kind === 'edge_traversed' && event.edge_id === edge.id);
    expect(arrived?.seq).toBeLessThan(starts[0].seq);
  }
  expect(visited_nodes.slice(-3)).toEqual(['git_merge', 'l1_milestone_review', 'l0_final_gate']);
});

test('a planner falls back to its first declared handle', () => {
  const graph: WorkflowGraph = {
    ...workerAndGate,
    nodes: [
      { id: 'plan', type: 'planner_node', label: 'Plan' },
      { id: 'routine', type: 'worker_node', label: 'Routine work' },
      { id: 'critical', type: 'worker_node', label: 'Critical work' },
    ],
    edges: [
      { id: 'critical-route', source: 'plan', sourceHandle: 'critical', target: 'critical' },
      { id: 'routine-route', source: 'plan', sourceHandle: 'routine', target: 'routine' },
    ],
  };
  expect(simulateGraph(graph, 'happy_path').visited_nodes).toEqual(['plan', 'critical']);
});

test.each([false, true])('escalate lets the gate pass with explicit escalation outlet = %s', (hasOutlet) => {
  const graph: WorkflowGraph = hasOutlet ? {
    ...workerAndGate,
    edges: [...workerAndGate.edges, { id: 'escalate', source: 'gate', target: 'approval', sourceHandle: 'escalate' }],
  } : workerAndGate;
  const result = simulateGraph(graph, 'escalate');

  expect(result.status).toBe('completed');
  expect(result.visited_nodes).toEqual(['worker', 'gate', 'approval']);
  expect(result.trace.filter(({ kind }) => kind === 'edge_traversed').map(({ edge_id }) => edge_id))
    .toEqual(['test', 'passed']);
  expect(simulateGraph({ ...graph, id: 'solo_coder_3tier' }, 'escalate')).toEqual(result);
});

test('a limited edge halts traversal when its budget is spent', () => {
  const graph: WorkflowGraph = {
    ...workerAndGate,
    nodes: workerAndGate.nodes.slice(0, 1),
    edges: [{ id: 'again', source: 'worker', target: 'worker', max_loops: 1 }],
  };
  const result = simulateGraph(graph, 'happy_path');
  expect(result.status).toBe('halted');
  expect(result.visited_nodes).toEqual(['worker', 'worker']);
  expect(result.trace.slice(-2)).toMatchObject([
    { kind: 'loop_limit_reached', edge_id: 'again', message: 'Traversal limit 1 reached' },
    { kind: 'graph_halted', message: 'No queued nodes remain after reaching a loop limit' },
  ]);
});

test('an exhausted edge leaves already queued nodes pending', () => {
  const graph: WorkflowGraph = {
    ...workerAndGate,
    nodes: [
      workerAndGate.nodes[0],
      { id: 'other', type: 'worker_node', label: 'Other entry' },
      workerAndGate.nodes[2],
    ],
    edges: [
      { id: 'again', source: 'worker', target: 'worker', max_loops: 1 },
      { id: 'finish', source: 'other', target: 'approval' },
    ],
  };
  const result = simulateGraph(graph, 'happy_path');

  expect(result.status).toBe('completed');
  expect(result.visited_nodes).toEqual(['worker', 'other', 'worker', 'approval']);
  expect(result.trace.slice(-4)).toMatchObject([
    { kind: 'loop_limit_reached', edge_id: 'again' },
    { kind: 'node_started', node_id: 'approval' },
    { kind: 'node_completed', node_id: 'approval' },
    { kind: 'graph_completed' },
  ]);
});

test('a returning edge inherits a limit from its cycle and still allows the exit route', () => {
  const result = simulateGraph(mergeInLoop, 'happy_path');
  expect(result.status).toBe('completed');
  expect(result.trace.filter(({ kind }) => kind === 'edge_traversed').map(({ edge_id }) => edge_id))
    .toEqual(['start', 'work', 'check', 'return', 'finish', 'work', 'check', 'finish']);
  expect(result.trace.filter(({ kind }) => kind === 'loop_limit_reached')).toMatchObject([
    { node_id: 'check', edge_id: 'return', outcome: 'out', message: 'Traversal limit 1.5 reached' },
  ]);
});

test('escalate chooses the reviewer escalation and then passes through the human gate', () => {
  const result = simulateGraph(reviewerRoutes, 'escalate');
  expect(result.status).toBe('completed');
  expect(result.visited_nodes).toEqual(['review', 'review', 'human', 'done']);
  expect(result.trace.filter(({ kind }) => kind === 'node_completed').map(({ outcome }) => outcome))
    .toEqual(['escalate', 'pass', 'approve', 'out']);
});

test.each([
  { removed: ['escalate'], outcomes: ['minor_fix', 'pass'] },
  { removed: ['escalate', 'minor_fix', 'pass'], outcomes: ['out'] },
  { removed: ['escalate', 'minor_fix', 'pass', 'out'], outcomes: ['reject'] },
])('reviewer outcomes are $outcomes with handles $removed removed', ({ removed, outcomes }) => {
  const graph = { ...reviewerRoutes, edges: reviewerRoutes.edges.filter(({ id }) => !removed.includes(id)) };
  const { trace } = simulateGraph(graph, 'escalate');
  expect(trace.filter(({ kind, node_id }) => kind === 'node_completed' && node_id === 'review')
    .map(({ outcome }) => outcome)).toEqual(outcomes);
});

test('reads legacy edge keys when validating and routing a retry', () => {
  const graph = {
    ...workerAndGate,
    edges: [
      workerAndGate.edges[0],
      { id: 'retry', source: 'gate', target: 'worker', source_handle: 'fail', target_handle: 'fix', maxLoops: 2 },
      workerAndGate.edges[2],
    ],
  };
  expect(validateGraph(graph)).toEqual(validateGraph(workerAndGate));
  expect(simulateGraph(graph, 'gate_retry')).toEqual(simulateGraph(workerAndGate, 'gate_retry'));
});
