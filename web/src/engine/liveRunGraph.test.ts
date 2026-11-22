import { describe, expect, test } from 'vitest';
import { flagship_4tier } from '../data/presets/flagship_4tier';
import type { LiveRunSnapshot } from '../types/graph';
import { buildLiveRunGraph, deriveLiveRoleStates, formatDurationSec, LIVE_GRAPH_ID, mapRunStatusToExecutionState } from './liveRunGraph';

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
  });

  test('localizes planner and gate titles in Chinese', () => {
    const view = buildLiveRunGraph(sampleSnapshot, 'zh');
    expect(view.graph.nodes.find((n) => n.id === 'live-planner')?.label).toBe('01_PLAN · 战术规划');
    expect(view.graph.nodes.find((n) => n.id === 'live-final-gate')?.label).toBe('L0 终审合入');
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
