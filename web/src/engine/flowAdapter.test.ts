import { expect, test } from 'vitest';
import { serializeModelPin } from '../components/nodes/readiness';
import { EMBEDDED_PRESETS } from '../data/presets';
import type { WorkflowGraph } from '../types/graph';
import { flowToGraph, graphToFlow } from './flowAdapter';

const positionedPresets = EMBEDDED_PRESETS.filter((graph) => graph.nodes.every((node) => node.position !== undefined));

test.each(positionedPresets)('round-trips $id with its positions and config', (graph) => {
  const { nodes, edges } = graphToFlow(graph);

  expect(flowToGraph(graph, nodes, edges)).toStrictEqual(graph);
});

test('propagates timing telemetry into React Flow data', () => {
  const timing = { duration_sec: 0, started_at: null, is_timing_active: false };
  const graph: WorkflowGraph = {
    schema_version: '1.0',
    id: 'live-timing',
    name: 'Live timing',
    nodes: [{
      id: 'build',
      type: 'worker_node',
      label: 'Build',
      config: { provider: 'codex_sub', ...timing },
    }],
    edges: [],
  };

  const { nodes: [worker] } = graphToFlow(graph);

  expect(worker.data).toMatchObject({ provider: 'codex_sub', ...timing });
});

test('exports a pinned worker, restores it from JSON, and removes the override when unpinned', () => {
  const graph: WorkflowGraph = {
    schema_version: '1.0',
    id: 'pinned-worker',
    name: 'Pinned worker',
    nodes: [{
      id: 'build',
      type: 'worker_node',
      label: 'Build',
      role: 'critical_executor',
      position: { x: 0, y: 0 },
      config: { provider: 'codex_sub', model: 'gpt-6.2-sol@max', concurrency: 2 },
    }],
    edges: [],
  };
  const { nodes: [worker], edges } = graphToFlow(graph);
  worker.data = {
    ...worker.data,
    ...serializeModelPin(true, worker.data),
    providerHealth: new Map([['codex_sub', { provider: 'codex_sub', ok: true, detail: 'Ready.' }]]),
  };

  const exported = flowToGraph(graph, [worker], edges);

  expect(exported.nodes[0].config).toStrictEqual({
    ...graph.nodes[0].config,
    pinned: true,
    assigned_model: 'codex_sub:gpt-6.2-sol@max',
  });
  expect(exported.nodes[0]).not.toHaveProperty('providerHealth');

  const imported = JSON.parse(JSON.stringify(exported)) as WorkflowGraph;
  const restored = graphToFlow(imported);
  const [restoredWorker] = restored.nodes;
  expect(restoredWorker.data).toMatchObject({ pinned: true, assigned_model: 'codex_sub:gpt-6.2-sol@max' });
  expect(flowToGraph(imported, restored.nodes, restored.edges)).toStrictEqual(imported);

  restoredWorker.data = { ...restoredWorker.data, ...serializeModelPin(false, restoredWorker.data) };
  expect(flowToGraph(imported, restored.nodes, restored.edges)).toStrictEqual(graph);
});

test('preserves a planner assignment explicitly marked as unpinned', () => {
  const graph: WorkflowGraph = {
    schema_version: '1.0',
    id: 'suggested-model',
    name: 'Suggested model',
    nodes: [{
      id: 'build',
      type: 'worker_node',
      label: 'Build',
      position: { x: 0, y: 0 },
      config: { pinned: false, assigned_model: 'codex_sub:gpt-6.2-sol' },
    }],
    edges: [],
  };

  const { nodes, edges } = graphToFlow(graph);

  expect(nodes[0].data).toMatchObject(graph.nodes[0].config!);
  expect(flowToGraph(graph, nodes, edges)).toStrictEqual(graph);
});

test('removes a null assignment when the imported pin is explicitly cleared', () => {
  const graph: WorkflowGraph = {
    schema_version: '1.0',
    id: 'empty-pin',
    name: 'Empty pin',
    nodes: [{
      id: 'build',
      type: 'worker_node',
      label: 'Build',
      position: { x: 0, y: 0 },
      config: { model: 'default', pinned: true, assigned_model: null },
    }],
    edges: [],
  };
  const { nodes: [worker], edges } = graphToFlow(graph);

  expect(flowToGraph(graph, [worker], edges)).toStrictEqual(graph);
  worker.data = { ...worker.data, ...serializeModelPin(false, worker.data) };
  expect(flowToGraph(graph, [worker], edges).nodes[0].config).toStrictEqual({ model: 'default' });
});

test('lays out missing positions by breadth-first depth and lane', () => {
  const graph: WorkflowGraph = {
    schema_version: '1.0',
    id: 'branches',
    name: 'Branches',
    nodes: [
      { id: 'build', type: 'worker_node', label: 'Build' },
      { id: 'review', type: 'reviewer_node', label: 'Review' },
      { id: 'plan', type: 'planner_node', label: 'Plan', position: { x: 40, y: 60 } },
      { id: 'merge', type: 'merge_node', label: 'Merge' },
      { id: 'isolated', type: 'human_gate_node', label: 'Isolated' },
      { id: 'cycle-a', type: 'worker_node', label: 'Cycle A' },
      { id: 'cycle-b', type: 'gate_node', label: 'Cycle B' },
    ],
    edges: [
      { id: 'start', source: 'plan', sourceHandle: 'dag', target: 'build' },
      { id: 'branch', source: 'plan', sourceHandle: 'critical', target: 'review', targetHandle: 'in' },
      { id: 'built', source: 'build', sourceHandle: 'out', target: 'merge' },
      { id: 'reviewed', source: 'review', target: 'merge' },
      { id: 'retry', source: 'merge', target: 'plan', max_loops: 2, condition: 'needs_revision' },
      { id: 'cycle-ab', source: 'cycle-a', target: 'cycle-b' },
      { id: 'cycle-ba', source: 'cycle-b', target: 'cycle-a' },
    ],
  };

  const { nodes, edges } = graphToFlow(graph, { build: 'active' });

  expect(nodes.map(({ position }) => position)).toStrictEqual([
    { x: 300, y: 0 },
    { x: 300, y: 160 },
    { x: 40, y: 60 },
    { x: 600, y: 0 },
    { x: 0, y: 160 },
    { x: 0, y: 320 },
    { x: 300, y: 320 },
  ]);
  expect(nodes[0]).toMatchObject({ type: 'baton', data: { nodeType: 'worker_node', state: 'active' } });
  expect(nodes[1].data.state).toBe('idle');
  expect(edges.slice(0, 3).map(({ label }) => label)).toStrictEqual([undefined, 'critical', undefined]);
  expect(edges[1]).toMatchObject({ id: 'branch', sourceHandle: 'critical', targetHandle: 'in' });
  expect(edges[4].data).toStrictEqual({ max_loops: 2, condition: 'needs_revision' });
});

test('writes canvas edits without exporting selection, playback, or undefined fields', () => {
  const graph: WorkflowGraph = {
    schema_version: '1.0',
    id: 'editable',
    name: 'Editable workflow',
    description: undefined,
    recommended_for: ['Example'],
    nodes: [
      {
        id: 'build',
        type: 'worker_node',
        label: 'Build',
        role: 'bulk_worker',
        position: { x: 0, y: 0 },
        config: { provider: 'dsh_opencode', model: 'old-model', max_loops: 2, concurrency: 3, unused: undefined },
      },
      { id: 'obsolete', type: 'gate_node', label: 'Obsolete', position: { x: 300, y: 0 } },
    ],
    edges: [{ id: 'obsolete-edge', source: 'build', target: 'obsolete' }],
  };
  const { nodes: [build] } = graphToFlow(graph);

  const edited = flowToGraph(graph, [
    {
      ...build,
      selected: true,
      position: { x: 100, y: 160 },
      data: { ...build.data, label: 'Compile', role: undefined, provider: 'codex_sub', model: undefined, max_loops: 0 },
    },
    {
      id: 'done',
      type: 'baton',
      position: { x: 400, y: 160 },
      data: { nodeType: 'human_gate_node', label: 'Done', role: 'reviewer', state: 'passed' },
    },
  ], [
    {
      id: 'e_build_out_done',
      source: 'build',
      sourceHandle: 'out',
      target: 'done',
      targetHandle: null,
      animated: true,
      label: 'Display label',
      data: { max_loops: 1, condition: 'success', displayNote: 'Canvas only' },
    },
  ]);

  expect(edited).toStrictEqual({
    schema_version: '1.0',
    id: 'editable',
    name: 'Editable workflow',
    recommended_for: ['Example'],
    nodes: [
      {
        id: 'build',
        type: 'worker_node',
        label: 'Compile',
        position: { x: 100, y: 160 },
        config: { provider: 'codex_sub', max_loops: 0, concurrency: 3 },
      },
      { id: 'done', type: 'human_gate_node', label: 'Done', role: 'reviewer', position: { x: 400, y: 160 } },
    ],
    edges: [{ id: 'e_build_out_done', source: 'build', sourceHandle: 'out', target: 'done', max_loops: 1, condition: 'success' }],
  });
});
