import { assert, describe, expect, test } from 'vitest';
import { starter_2tier } from '../data/presets/starter_2tier';
import type { ExecutionState, GraphTraceEvent, TraceKind } from '../types/graph';
import { simulateGraph } from './localSimulator';
import { deriveStates, SPEEDS, stepIntervalMs } from './playback';

const happyTrace = simulateGraph(starter_2tier, 'happy_path').trace;
const retryTrace = simulateGraph(starter_2tier, 'gate_retry').trace;

describe('deriveStates', () => {
  test('passes all four starter nodes after the happy path', () => {
    const lastEvent = happyTrace[happyTrace.length - 1];
    const result = deriveStates(starter_2tier, happyTrace, lastEvent.seq);

    expect(result.nodeStates).toEqual({ plan: 'passed', worker: 'passed', gate: 'passed', final: 'passed' });
    expect(result.currentEvent).toBe(lastEvent);
  });

  test('activates only the planner at the first node start', () => {
    const firstEvent = happyTrace.find(({ kind }) => kind === 'node_started');
    assert(firstEvent, 'Expected the starter trace to start a node');
    const result = deriveStates(starter_2tier, happyTrace, firstEvent.seq);

    expect(result.nodeStates).toEqual({ plan: 'active', worker: 'idle', gate: 'idle', final: 'idle' });
    expect(result.activeEdgeIds.size).toBe(0);
    expect(result.currentEvent).toBe(firstEvent);
  });

  test('marks the gate as retrying at its failed completion', () => {
    const failure = retryTrace.find(({ kind, node_id, outcome }) =>
      kind === 'node_completed' && node_id === 'gate' && outcome === 'fail',
    );
    assert(failure, 'Expected a failed gate completion in the retry trace');
    const result = deriveStates(starter_2tier, retryTrace, failure.seq);

    expect(result.nodeStates.gate).toBe('retrying');
    expect(result.activeEdgeIds).toEqual(new Set(['s2']));
    expect(result.traversedEdgeIds).toEqual(new Set(['s1', 's2']));
    expect(result.currentEvent).toBe(failure);
  });

  test('records graph edges once and keeps the latest traversal active', () => {
    const lastEvent = retryTrace[retryTrace.length - 1];
    const result = deriveStates(starter_2tier, retryTrace, lastEvent.seq);

    expect(result.nodeStates.gate).toBe('passed');
    expect(result.traversedEdgeIds).toEqual(new Set(starter_2tier.edges.map(({ id }) => id)));
    expect(result.activeEdgeIds).toEqual(new Set(['s4']));
  });

  test('starts with every node idle and no current event or edges', () => {
    expect(deriveStates(starter_2tier, happyTrace, -1)).toEqual({
      nodeStates: { plan: 'idle', worker: 'idle', gate: 'idle', final: 'idle' },
      activeEdgeIds: new Set(),
      traversedEdgeIds: new Set(),
      currentEvent: null,
    });
  });

  test.each([
    ['node_completed', 'critical', 'passed'],
    ['node_completed', 'routine', 'passed'],
    ['node_completed', 'completed', 'passed'],
    ['node_completed', 'escalate', 'escalated'],
    ['node_completed', 'reject', 'escalated'],
    ['node_completed', 'minor_fix', 'active'],
    ['node_failed', null, 'failed'],
    ['loop_limit_reached', 'fail', 'failed'],
  ] satisfies [TraceKind, string | null, ExecutionState][])(
    'maps %s with outcome %s to %s',
    (kind, outcome, expectedState) => {
      const start = happyTrace[0];
      const end: GraphTraceEvent = { ...start, seq: start.seq + 1, kind, outcome };

      expect(deriveStates(starter_2tier, [start, end], end.seq).nodeStates.plan).toBe(expectedState);
    },
  );

  test('uses event sequence order without changing the original trace', () => {
    const reversed = [...happyTrace].reverse();
    const lastEvent = reversed[0];

    expect(deriveStates(starter_2tier, reversed, lastEvent.seq)).toEqual(
      deriveStates(starter_2tier, happyTrace, lastEvent.seq),
    );
    expect(reversed[0]).toBe(lastEvent);
  });

  test('keeps stale IDs out of the current graph highlights', () => {
    const lastEvent = happyTrace[happyTrace.length - 1];
    const staleStart: GraphTraceEvent = {
      ...lastEvent,
      seq: lastEvent.seq + 1,
      kind: 'node_started',
      node_id: 'old-node',
    };
    const staleTraverse: GraphTraceEvent = {
      ...staleStart,
      seq: staleStart.seq + 1,
      kind: 'edge_traversed',
      edge_id: 'old-edge',
    };
    const result = deriveStates(starter_2tier, [...happyTrace, staleStart, staleTraverse], staleTraverse.seq);

    expect(Object.keys(result.nodeStates)).toEqual(starter_2tier.nodes.map(({ id }) => id));
    expect(result.traversedEdgeIds).not.toContain('old-edge');
    expect(result.activeEdgeIds).toEqual(new Set(['s4']));
    expect(result.currentEvent).toBe(staleTraverse);
  });
});

test('sets the step interval for each playback speed', () => {
  expect(SPEEDS).toEqual([0.5, 1, 2]);
  expect(SPEEDS.map(stepIntervalMs)).toEqual([1800, 900, 450]);
});
