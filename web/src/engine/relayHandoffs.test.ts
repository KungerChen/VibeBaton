import { describe, expect, test } from 'vitest';
import type { RunHandoff } from '../api/client';
import type { LiveRunSnapshot } from '../types/graph';
import { graphToFlow } from './flowAdapter';
import { buildLiveRunGraph, PANEL_SYNTHESIZER_NODE_ID } from './liveRunGraph';
import { handoffIdForEdge, handoffRefFromNodeId, relayEdges, UNRECORDED_EDGE_STYLE } from './relayHandoffs';

function handoff(id: string, recorded: boolean): RunHandoff {
  const [from, to] = id.split('>');
  const ref = (text: string) => {
    const [kind, ref] = text.split(':');
    return { kind: kind as RunHandoff['from']['kind'], id: ref ?? null };
  };
  return {
    id, from: ref(from), to: ref(to), recorded, event_ids: recorded ? [1] : [], at: recorded ? 10 : null,
    invocations: [], changed_files: null, receipts: [], review: null, takeover: { status: null, holder: null }, blocked_reason: null,
  };
}

describe('edge to handoff mapping', () => {
  test('live node ids become handoff ends', () => {
    expect(handoffRefFromNodeId('live-planner')).toBe('planner');
    expect(handoffRefFromNodeId('live-task-M1-T2')).toBe('task:M1-T2');
    expect(handoffRefFromNodeId('live-ms-M1')).toBe('milestone:M1');
    expect(handoffRefFromNodeId('live-final-gate')).toBe('final_gate');
    expect(handoffRefFromNodeId('live-task-')).toBeNull();
    expect(handoffRefFromNodeId('live-ms-')).toBeNull();
    expect(handoffRefFromNodeId(PANEL_SYNTHESIZER_NODE_ID)).toBeNull();
    expect(handoffRefFromNodeId('live-panel-specialist-a')).toBeNull();
  });

  test('every plan edge maps to the server handoff id; panel edges map to nothing', () => {
    expect(handoffIdForEdge('live-planner', 'live-task-T1')).toBe('planner>task:T1');
    expect(handoffIdForEdge('live-task-T1', 'live-ms-M1')).toBe('task:T1>milestone:M1');
    expect(handoffIdForEdge('live-ms-M1', 'live-task-T2')).toBe('milestone:M1>task:T2');
    expect(handoffIdForEdge('live-planner', 'live-ms-M1')).toBe('planner>milestone:M1');
    expect(handoffIdForEdge('live-ms-M1', 'live-final-gate')).toBe('milestone:M1>final_gate');
    expect(handoffIdForEdge('live-planner', 'live-final-gate')).toBe('planner>final_gate');
    expect(handoffIdForEdge(PANEL_SYNTHESIZER_NODE_ID, 'live-planner')).toBeNull();
    expect(handoffIdForEdge('live-panel-specialist-a', PANEL_SYNTHESIZER_NODE_ID)).toBeNull();
  });

  test('the ids line up with the edges the live graph draws', () => {
    const snapshot: LiveRunSnapshot = {
      run: { id: 'r1', status: 'RUNNING' },
      milestones: [{ id: 'M1', status: 'PASSED' }, { id: 'M2', status: 'RUNNING' }],
      tasks: [{ id: 'T1', milestone_id: 'M1', status: 'PASSED' }, { id: 'T2', milestone_id: 'M2', status: 'RUNNING' }],
      events: [], quotas: [],
    };
    const { graph } = buildLiveRunGraph(snapshot, 'en');
    expect(graph.edges.map(({ source, target }) => handoffIdForEdge(source, target))).toEqual([
      'planner>task:T1', 'task:T1>milestone:M1', 'milestone:M1>task:T2', 'task:T2>milestone:M2', 'milestone:M2>final_gate',
    ]);
  });
});

describe('recorded and planned-only edges', () => {
  const snapshot: LiveRunSnapshot = {
    run: { id: 'r1', status: 'RUNNING' },
    milestones: [{ id: 'M1', status: 'RUNNING' }],
    tasks: [{ id: 'T1', milestone_id: 'M1', status: 'PASSED' }, { id: 'T2', milestone_id: 'M1', status: 'RUNNING' }],
    events: [], quotas: [],
  };
  const view = buildLiveRunGraph(snapshot, 'en');
  const { edges } = graphToFlow(view.graph, view.nodeStates);
  const byId = <T extends { id: string }>(list: T[], id: string) => list.find((edge) => edge.id === id);
  const intoT1 = 'live-edge-live-planner-to-live-task-T1';
  const t1Out = 'live-edge-live-task-T1-to-live-ms-M1';
  const intoT2 = 'live-edge-live-planner-to-live-task-T2';

  test('the graph itself marks these edges active or walked', () => {
    expect(view.traversedEdgeIds.has(intoT1)).toBe(true);
    expect(view.traversedEdgeIds.has(t1Out)).toBe(true);
    expect(view.activeEdgeIds.has(intoT2)).toBe(true);
  });

  test('a recorded handoff keeps the live look; recorded=false, a missing entry and a list not loaded are dashed', () => {
    const handoffs = [handoff('planner>task:T1', true), handoff('task:T1>milestone:M1', false), handoff('planner>task:T2', true)];
    const shown = relayEdges(edges, handoffs, view.activeEdgeIds, view.traversedEdgeIds);
    expect(byId(shown.edges, intoT1)).toMatchObject({ data: { recorded: true } });
    expect(byId(shown.edges, intoT1)?.style).toBeUndefined();
    expect(byId(shown.edges, intoT1)?.className).toBeUndefined();
    expect(byId(shown.edges, t1Out)).toMatchObject({
      className: 'guided-relay__edge--unrecorded', style: UNRECORDED_EDGE_STYLE, data: { recorded: false },
    });
    // T2 into the milestone has no entry in the list at all.
    expect(byId(shown.edges, 'live-edge-live-task-T2-to-live-ms-M1')).toMatchObject({ data: { recorded: false }, style: UNRECORDED_EDGE_STYLE });
    expect(view.activeEdgeIds.has(t1Out)).toBe(true);
    expect(shown.traversedEdgeIds).toEqual(new Set([intoT1, intoT2]));
    expect(shown.activeEdgeIds).toEqual(new Set([intoT2]));

    const notLoaded = relayEdges(edges, null, view.activeEdgeIds, view.traversedEdgeIds);
    expect(notLoaded.edges.every((edge) => edge.data?.recorded === false && edge.style?.strokeDasharray === '6 5')).toBe(true);
    expect(notLoaded.activeEdgeIds.size).toBe(0);
    expect(notLoaded.traversedEdgeIds.size).toBe(0);
  });

  test('a passed node does not make its edge recorded', () => {
    expect(view.nodeStates['live-task-T1']).toBe('passed');
    const shown = relayEdges(edges, [], view.activeEdgeIds, view.traversedEdgeIds);
    expect(byId(shown.edges, t1Out)?.data?.recorded).toBe(false);
    expect(shown.traversedEdgeIds.has(t1Out)).toBe(false);
  });
});
