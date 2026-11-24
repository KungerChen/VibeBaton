import { applyNodeChanges } from '@xyflow/react';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { CanvasWorkspace } from '../components/CanvasWorkspace';
import { flagship_4tier } from '../data/presets/flagship_4tier';
import type { LiveRunSnapshot, RunTelemetry, StageTelemetry } from '../types/graph';
import { flowToGraph, graphToFlow } from './flowAdapter';
import { formatDurationSec } from './liveClock';
import {
  buildLiveRunGraph,
  deriveLiveRoleStates,
  LIVE_GRAPH_ID,
  mapRunStatusToExecutionState,
  projectLiveRunCanvas,
} from './liveRunGraph';

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  // The outer provider fills its store after mount. Let React Flow seed its own store during SSR.
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
}));

describe('formatDurationSec', () => {
  test('formats zero, seconds, minutes, and hours in en and zh', () => {
    expect(formatDurationSec(0, 'en')).toBe('0s');
    expect(formatDurationSec(0, 'zh')).toBe('0秒');
    expect(formatDurationSec(42.5, 'en')).toBe('42.5s');
    expect(formatDurationSec(42.5, 'zh')).toBe('42.5秒');
    expect(formatDurationSec(754, 'en')).toBe('12m 34s');
    expect(formatDurationSec(754, 'zh')).toBe('12分34秒');
    expect(formatDurationSec(19440, 'en')).toBe('5h 24m');
    expect(formatDurationSec(19440, 'zh')).toBe('5时24分');
  });
});

describe('mapRunStatusToExecutionState', () => {
  test('maps backend statuses onto canvas execution states', () => {
    expect(mapRunStatusToExecutionState('PASSED')).toBe('passed');
    expect(mapRunStatusToExecutionState('READY_FOR_FINAL_GATE')).toBe('active');
    expect(mapRunStatusToExecutionState('WAITING_HUMAN')).toBe('active');
    expect(mapRunStatusToExecutionState('PAUSED')).toBe('retrying');
    expect(mapRunStatusToExecutionState('ESCALATED')).toBe('escalated');
    expect(mapRunStatusToExecutionState('FAILED')).toBe('failed');
    expect(mapRunStatusToExecutionState('PENDING')).toBe('idle');
  });
});

describe('buildLiveRunGraph', () => {
  const sampleSnapshot: LiveRunSnapshot = {
    run: { id: 'run-stage3', status: 'READY_FOR_FINAL_GATE', mode: 'overnight' },
    milestones: [
      { id: 'M1', title: 'Core Contracts', status: 'PASSED' },
      { id: 'M2', title: 'UI Wiring', status: 'PASSED' },
    ],
    tasks: [
      { id: 'T1', milestone_id: 'M1', title: 'Define schema', status: 'PASSED', current_role: 'critical_executor' },
      { id: 'T2', milestone_id: 'M1', title: 'Build client', status: 'PASSED', assignee_role: 'bulk_worker' },
      { id: 'T3', milestone_id: 'M2', title: 'Render canvas', status: 'PASSED', current_role: 'bulk_worker' },
    ],
    events: [
      { id: 1, kind: 'plan_registered', task_id: null, message: 'Plan registered' },
      { id: 2, kind: 'role_invoked', task_id: 'T2', message: 'Invoking bulk_worker (dsh_opencode/deepseek-chat)' },
    ],
    quotas: [],
    telemetry: null,
  };

  const planningStage: StageTelemetry = {
    id: 'PLANNING',
    kind: 'planning',
    title: 'DAG Planning',
    status: 'PLANNING',
    wall_sec: 20,
    task_sum_sec: 0,
    passed_tasks: 0,
    total_tasks: 0,
    started_at: 100,
    is_active: true,
  };

  test('builds planning -> milestones/tasks -> L0 final gate DAG with states and glowing edges', () => {
    const view = buildLiveRunGraph(sampleSnapshot, 'en');
    expect(view.graph.id).toBe(LIVE_GRAPH_ID);
    expect(view.graph.nodes.map((n) => n.id)).toEqual([
      'live-planner',
      'live-task-T1',
      'live-task-T2',
      'live-ms-M1',
      'live-task-T3',
      'live-ms-M2',
      'live-final-gate',
    ]);
    expect(view.nodeStates['live-planner']).toBe('passed');
    expect(view.nodeStates['live-ms-M2']).toBe('passed');
    expect(view.nodeStates['live-final-gate']).toBe('active');
    expect(view.graph.nodes.find((n) => n.id === 'live-task-T2')?.config).toEqual({
      provider: 'dsh_opencode',
      model: 'deepseek-chat',
    });
    expect(view.traversedEdgeIds.has('live-edge-live-planner-to-live-task-T1')).toBe(true);
    expect(view.activeEdgeIds.has('live-edge-live-ms-M2-to-live-final-gate')).toBe(true);
    expect(view.graph.nodes.every(({ config }) => config?.duration_sec === undefined)).toBe(true);
    expect(buildLiveRunGraph({ ...sampleSnapshot, telemetry: undefined }, 'en', 150)).toStrictEqual(view);
  });

  test('localizes planner and gate titles in Chinese', () => {
    const view = buildLiveRunGraph(sampleSnapshot, 'zh');
    expect(view.graph.nodes.find((n) => n.id === 'live-planner')?.label).toBe('01_PLAN · 战术规划');
    expect(view.graph.nodes.find((n) => n.id === 'live-final-gate')?.label).toBe('L0 终审合入');
  });

  test('leaves the non-panel graph deep-equal to the previous output', () => {
    const view = buildLiveRunGraph({
      run: { id: 'run-overnight', status: 'COMPLETED' },
      milestones: [],
      tasks: [],
      events: [],
      quotas: [],
    }, 'en');

    expect(view).toStrictEqual({
      graph: {
        schema_version: '1.0',
        id: LIVE_GRAPH_ID,
        name: 'Live Run · run-overnight',
        difficulty: 'live',
        description: 'Live execution workflow for run-overnight (COMPLETED).',
        nodes: [
          {
            id: 'live-planner',
            type: 'planner_node',
            label: '01_PLAN · Tactical Plan',
            role: 'tactical_planner',
            position: { x: 0, y: 120 },
            config: undefined,
          },
          {
            id: 'live-final-gate',
            type: 'human_gate_node',
            label: 'L0 Final Gate',
            role: 'brainstorm_and_final_gate',
            position: { x: 340, y: 120 },
            config: { provider: 'host_native', model: 'L0' },
          },
        ],
        edges: [{
          id: 'live-edge-live-planner-to-live-final-gate',
          source: 'live-planner',
          target: 'live-final-gate',
          sourceHandle: 'dag',
          targetHandle: 'in',
        }],
      },
      nodeStates: { 'live-planner': 'passed', 'live-final-gate': 'passed' },
      activeEdgeIds: new Set(),
      traversedEdgeIds: new Set(['live-edge-live-planner-to-live-final-gate']),
    });
  });

  const panelStage: StageTelemetry = {
    id: '00_PANEL',
    kind: 'panel',
    title: 'Panel & Synthesis',
    status: 'RUNNING',
    wall_sec: 20,
    task_sum_sec: 0,
    passed_tasks: 0,
    total_tasks: 0,
    started_at: 100,
    is_active: true,
  };

  const panelSnapshot: LiveRunSnapshot = {
    run: { id: 'run-panel', status: 'RUNNING' },
    milestones: [],
    tasks: [],
    events: [
      {
        id: 1,
        kind: 'panel_started',
        message: 'Panel started with 2 specialists',
        payload_json: JSON.stringify({ member_count: 2 }),
      },
      {
        id: 2,
        kind: 'panel_member_completed',
        message: 'Panel specialist ux completed',
        payload_json: JSON.stringify({
          member_id: 'ux',
          perspective: 'UX & Copy',
          provider: 'claude_sub',
          model: 'opus@high',
          ok: true,
        }),
      },
      {
        id: 3,
        kind: 'panel_member_completed',
        message: 'Panel specialist safety failed',
        payload_json: JSON.stringify({
          member_id: 'safety',
          perspective: 'Source & Safety',
          provider: 'codex_sub',
          model: 'gpt-6.2-sol@max',
          ok: false,
          error: 'timeout',
        }),
      },
    ],
    quotas: [],
    telemetry: { elapsed_sec: 20, server_now: 120, stages: [panelStage], models: [] },
  };

  test('synthesizes specialist and synthesizer nodes before 01_PLAN from panel events', () => {
    const view = buildLiveRunGraph(panelSnapshot, 'en');

    expect(view.graph.nodes.map((n) => n.id)).toEqual([
      'live-panel-specialist-ux',
      'live-panel-specialist-safety',
      'live-panel-synthesizer',
      'live-planner',
      'live-final-gate',
    ]);
    expect(view.graph.nodes.find((n) => n.id === 'live-panel-specialist-ux')?.label).toBe('Specialist · UX & Copy');
    expect(view.graph.nodes.find((n) => n.id === 'live-panel-specialist-safety')?.label).toBe('Specialist · Source & Safety');
    expect(view.graph.nodes.find((n) => n.id === 'live-panel-synthesizer')?.label).toBe('Synthesizer');

    expect(view.nodeStates['live-panel-specialist-ux']).toBe('passed');
    expect(view.nodeStates['live-panel-specialist-safety']).toBe('failed');
    expect(view.nodeStates['live-panel-synthesizer']).toBe('active');

    expect(view.graph.nodes.find((n) => n.id === 'live-panel-specialist-ux')?.config).toEqual({
      provider: 'claude_sub',
      model: 'opus@high',
    });
    expect(view.graph.nodes.find((n) => n.id === 'live-panel-synthesizer')?.config).toEqual({
      duration_sec: 20,
      started_at: 100,
      is_timing_active: true,
    });

    expect(view.graph.edges.map(({ source, target }) => [source, target])).toEqual([
      ['live-panel-specialist-ux', 'live-panel-synthesizer'],
      ['live-panel-specialist-safety', 'live-panel-synthesizer'],
      ['live-panel-synthesizer', 'live-planner'],
      ['live-planner', 'live-final-gate'],
    ]);
    expect(view.graph.edges.find((e) => e.target === 'live-planner')).toMatchObject({
      source: 'live-panel-synthesizer',
      sourceHandle: 'out',
      targetHandle: 'in',
    });
    expect(view.traversedEdgeIds.has('live-edge-live-panel-specialist-ux-to-live-panel-synthesizer')).toBe(true);
  });

  test('localizes the panel graph nodes in Chinese', () => {
    const view = buildLiveRunGraph(panelSnapshot, 'zh');
    expect(view.graph.nodes.find((n) => n.id === 'live-panel-specialist-ux')?.label).toBe('会诊专家 · UX & Copy');
    expect(view.graph.nodes.find((n) => n.id === 'live-panel-synthesizer')?.label).toBe('综合裁决');
  });

  test('synthesizes the panel group from the 00_PANEL telemetry stage alone', () => {
    const view = buildLiveRunGraph({
      run: { id: 'run-panel', status: 'RUNNING' },
      milestones: [],
      tasks: [],
      events: [],
      quotas: [],
      telemetry: { elapsed_sec: 20, stages: [panelStage], models: [] },
    }, 'en');

    expect(view.graph.nodes.map((n) => n.id)).toEqual([
      'live-panel-synthesizer',
      'live-planner',
      'live-final-gate',
    ]);
    expect(view.graph.edges.map((e) => e.id)).toEqual([
      'live-edge-live-panel-synthesizer-to-live-planner',
      'live-edge-live-planner-to-live-final-gate',
    ]);
    expect(view.nodeStates['live-panel-synthesizer']).toBe('active');
  });

  test('advances an active planner from the snapshot clock', () => {
    const snapshot: LiveRunSnapshot = {
      run: { id: 'run-planning', status: 'PLANNING' },
      milestones: [],
      tasks: [],
      events: [],
      quotas: [],
      telemetry: { elapsed_sec: 20, server_now: 120, stages: [planningStage], models: [] },
    };

    const timing = { duration_sec: 20, started_at: 100, is_timing_active: true };
    expect(buildLiveRunGraph(snapshot, 'en').graph.nodes[0].config).toEqual(timing);
    expect(buildLiveRunGraph(snapshot, 'en', 119).graph.nodes[0].config).toEqual(timing);
    expect(buildLiveRunGraph(snapshot, 'en', 123).graph.nodes[0].config).toEqual({
      ...timing,
      duration_sec: 23,
    });
  });

  test('keeps the canvas layout when a running snapshot only advances its clock', () => {
    const telemetry: RunTelemetry = {
      elapsed_sec: 20,
      server_now: 120,
      models: [],
      stages: [{
        id: 'M1', kind: 'milestone', title: 'Core Contracts', status: 'RUNNING',
        wall_sec: 20, task_sum_sec: 8, passed_tasks: 1, total_tasks: 2,
        started_at: 100, is_active: true,
      }],
      task_timings: { T2: { duration_sec: 8, started_at: 112, is_active: true } },
    };
    const snapshot: LiveRunSnapshot = {
      ...sampleSnapshot,
      run: { id: 'run-active', status: 'RUNNING' },
      milestones: sampleSnapshot.milestones.map((ms) => ms.id === 'M1' ? { ...ms, status: 'RUNNING' } : ms),
      tasks: sampleSnapshot.tasks.map((task) => task.id === 'T2' ? { ...task, status: 'RUNNING' } : task),
      telemetry,
    };
    const first = projectLiveRunCanvas(buildLiveRunGraph(snapshot, 'en').graph);
    const refreshed = buildLiveRunGraph({
      ...snapshot,
      telemetry: {
        ...telemetry,
        elapsed_sec: 25,
        server_now: 125,
        stages: [{ ...telemetry.stages[0], wall_sec: 25 }],
        task_timings: { T2: { duration_sec: 13, started_at: 112, is_active: true } },
      },
    }, 'en');
    const next = projectLiveRunCanvas(refreshed.graph);

    const taskId = 'live-task-T2';
    const position = { x: 640, y: 380 };
    const flow = graphToFlow(first.graph);
    const dragged = applyNodeChanges([
      { id: taskId, type: 'position', position },
      { id: taskId, type: 'select', selected: true },
    ], flow.nodes);
    const nodes = next.signature === first.signature ? dragged : graphToFlow(next.graph).nodes;
    expect(nodes.find(({ id }) => id === taskId)).toMatchObject({ position, selected: true });
    expect(first.nodeTimings.get(taskId)?.duration_sec).toBe(8);
    expect(next.nodeTimings.get(taskId)).toEqual({ duration_sec: 13, started_at: 112, is_timing_active: true });
    expect(next.nodeTimings.get('live-ms-M1')?.duration_sec).toBe(25);

    const noop = () => {};
    const canvas = renderToStaticMarkup(createElement(CanvasWorkspace, {
      ...flow,
      nodes,
      liveTiming: { nodeTimings: next.nodeTimings, server_now: 125, now_epoch_sec: 128 },
      onNodesChange: noop,
      onEdgesChange: noop,
      onConnect: noop,
      onSelectionChange: noop,
      activeEdgeIds: refreshed.activeEdgeIds,
      traversedEdgeIds: refreshed.traversedEdgeIds,
    }));
    expect(canvas).toContain('translate(640px,380px)');
    expect(canvas).toContain('baton-node--selected');
    expect(canvas).toContain('<span class="sr-only">Live timer running</span><span aria-hidden="true">●</span>16s');

    const shared = flowToGraph(first.graph, nodes, flow.edges);
    const sharedTask = shared.nodes.find(({ id }) => id === taskId);
    expect(sharedTask?.position).toEqual(position);
    expect(sharedTask?.config).toEqual({ provider: 'dsh_opencode', model: 'deepseek-chat' });
    expect(shared.nodes.find(({ id }) => id === 'live-ms-M1')?.config).toBeUndefined();
  });

  test.each(['GATE_CHECKING', 'COOLDOWN'])('keeps the %s task timing pill at its recorded duration', (status) => {
    const snapshot: LiveRunSnapshot = {
      ...sampleSnapshot,
      run: { id: 'run-active', status: 'RUNNING' },
      tasks: [{ id: 'T2', milestone_id: 'M1', title: 'Build client', status }],
      telemetry: {
        elapsed_sec: 25,
        server_now: 125,
        stages: [],
        models: [],
        task_timings: { T2: { duration_sec: 13, started_at: null, is_active: true } },
      },
    };
    const view = buildLiveRunGraph(snapshot, 'en');
    const { graph, nodeTimings } = projectLiveRunCanvas(view.graph);
    const noop = () => {};
    const canvas = renderToStaticMarkup(createElement(CanvasWorkspace, {
      ...graphToFlow(graph),
      liveTiming: { nodeTimings, server_now: 125, now_epoch_sec: 128 },
      onNodesChange: noop,
      onEdgesChange: noop,
      onConnect: noop,
      onSelectionChange: noop,
      activeEdgeIds: view.activeEdgeIds,
      traversedEdgeIds: view.traversedEdgeIds,
    }));

    expect(canvas).toContain('class="baton-node-timing gap-1" data-active="true"');
    expect(canvas).toContain('<span aria-hidden="true">●</span>13s</span>');
  });

  test('reuses the layout as timing starts, stops, or disappears', () => {
    const snapshot: LiveRunSnapshot = {
      run: { id: 'run-planning', status: 'PLANNING' },
      milestones: [], tasks: [], events: [], quotas: [],
    };
    const initial = projectLiveRunCanvas(buildLiveRunGraph(snapshot, 'en').graph);
    const active = projectLiveRunCanvas(buildLiveRunGraph({
      ...snapshot,
      telemetry: { elapsed_sec: 20, server_now: 120, stages: [planningStage], models: [] },
    }, 'en').graph);
    const stopped = projectLiveRunCanvas(buildLiveRunGraph({
      ...snapshot,
      run: { ...snapshot.run, status: 'FAILED' },
      telemetry: {
        elapsed_sec: 22, server_now: 122, models: [],
        stages: [{ ...planningStage, wall_sec: 22, is_active: false, started_at: null }],
      },
    }, 'en').graph);

    expect(active.signature).toBe(initial.signature);
    expect(stopped.signature).toBe(initial.signature);
    expect(initial.nodeTimings.has('live-planner')).toBe(false);
    expect(stopped.nodeTimings.get('live-planner')).toEqual({
      duration_sec: 22, started_at: null, is_timing_active: false,
    });
  });

  test('changes the layout signature when the task topology or model assignment changes', () => {
    const initial = projectLiveRunCanvas(buildLiveRunGraph(sampleSnapshot, 'en').graph);
    const addedTask = projectLiveRunCanvas(buildLiveRunGraph({
      ...sampleSnapshot,
      tasks: [...sampleSnapshot.tasks, { id: 'T4', milestone_id: 'M2', status: 'PENDING' }],
    }, 'en').graph);
    const reassigned = projectLiveRunCanvas(buildLiveRunGraph({
      ...sampleSnapshot,
      tasks: sampleSnapshot.tasks.map((task) =>
        task.id === 'T2' ? { ...task, assigned_model: 'codex_sub/codex-sol' } : task),
    }, 'en').graph);

    expect(addedTask.signature).not.toBe(initial.signature);
    expect(reassigned.signature).not.toBe(initial.signature);
  });

  test('matches active and completed timing rows by task and milestone ID', () => {
    const snapshot: LiveRunSnapshot = {
      ...sampleSnapshot,
      run: { id: 'run-active', status: 'RUNNING' },
      milestones: sampleSnapshot.milestones.map((ms) => (
        ms.id === 'M1' ? { ...ms, status: 'RUNNING' } : ms
      )),
      tasks: sampleSnapshot.tasks.map((task) => (
        task.id === 'T2' ? { ...task, status: 'RUNNING' } : task
      )),
      telemetry: {
        elapsed_sec: 60,
        server_now: 160,
        models: [],
        stages: [
          { ...planningStage, status: 'PASSED', started_at: null, is_active: false },
          {
            id: 'M2', kind: 'milestone', title: 'UI Wiring', status: 'PASSED',
            wall_sec: 15, task_sum_sec: 6, passed_tasks: 1, total_tasks: 1,
            started_at: null, is_active: false,
          },
          {
            id: 'M1', kind: 'milestone', title: 'Core Contracts', status: 'RUNNING',
            wall_sec: 40, task_sum_sec: 20, passed_tasks: 1, total_tasks: 2,
            started_at: 120, is_active: true,
          },
        ],
        task_timings: {
          T1: { duration_sec: 20, started_at: null, is_active: false },
          T2: { duration_sec: 12, started_at: 148, is_active: true },
        },
      },
    };

    const { graph } = buildLiveRunGraph(snapshot, 'en', 165);
    const configs = Object.fromEntries(graph.nodes.map(({ id, config }) => [id, config]));
    expect(configs['live-planner']).toEqual({ duration_sec: 20, started_at: null, is_timing_active: false });
    expect(configs['live-task-T1']).toEqual({ duration_sec: 20, started_at: null, is_timing_active: false });
    expect(configs['live-task-T2']).toEqual({
      provider: 'dsh_opencode',
      model: 'deepseek-chat',
      duration_sec: 17,
      started_at: 148,
      is_timing_active: true,
    });
    expect(configs['live-task-T3']?.duration_sec).toBeUndefined();
    expect(configs['live-ms-M1']).toEqual({ duration_sec: 45, started_at: 120, is_timing_active: true });
    expect(configs['live-ms-M2']).toEqual({ duration_sec: 15, started_at: null, is_timing_active: false });
    expect(configs['live-final-gate']?.duration_sec).toBeUndefined();
  });
});

describe('deriveLiveRoleStates', () => {
  test('mirrors active live roles onto static preset nodes and stays idle for completed runs', () => {
    const running: LiveRunSnapshot = {
      run: { id: 'run-active', status: 'RUNNING' },
      milestones: [{ id: 'M1', title: 'M1', status: 'IN_PROGRESS' }],
      tasks: [{ id: 'T1', milestone_id: 'M1', title: 'T1', status: 'RUNNING', current_role: 'bulk_worker' }],
      events: [],
      quotas: [],
    };
    const activeStates = deriveLiveRoleStates(flagship_4tier, running);
    const l1 = flagship_4tier.nodes.find((n) => n.role === 'tactical_planner');
    const l3 = flagship_4tier.nodes.find((n) => n.role === 'bulk_worker');
    expect(l1 && activeStates[l1.id]).toBe('passed');
    expect(l3 && activeStates[l3.id]).toBe('active');

    const completed: LiveRunSnapshot = {
      ...running,
      run: { id: 'run-done', status: 'COMPLETED' },
    };
    const idleStates = deriveLiveRoleStates(flagship_4tier, completed);
    expect(Object.values(idleStates).every((s) => s === 'idle')).toBe(true);
  });
});
