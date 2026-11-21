import type { ExecutionState, GraphTraceEvent, WorkflowGraph } from '../types/graph';

export const SPEEDS = [0.5, 1, 2] as const;

const PASSED_OUTCOMES = new Set(['pass', 'approve', 'out', 'dag', 'critical', 'routine', 'completed']);

export function stepIntervalMs(speed: number): number {
  return 900 / speed;
}

export function deriveStates(
  graph: WorkflowGraph,
  trace: GraphTraceEvent[],
  upToSeq: number,
): {
  nodeStates: Record<string, ExecutionState>;
  activeEdgeIds: Set<string>;
  traversedEdgeIds: Set<string>;
  currentEvent: GraphTraceEvent | null;
} {
  const nodeStates: Record<string, ExecutionState> = Object.fromEntries(
    graph.nodes.map(({ id }) => [id, 'idle'] as const),
  );
  const edgeIds = new Set(graph.edges.map(({ id }) => id));
  const traversedEdgeIds = new Set<string>();
  let activeEdgeId: string | null = null;
  let currentEvent: GraphTraceEvent | null = null;

  const events = trace.filter(({ seq }) => seq <= upToSeq).sort((a, b) => a.seq - b.seq);
  for (const event of events) {
    currentEvent = event;
    const { kind, node_id: nodeId, edge_id: edgeId, outcome } = event;

    if (kind === 'edge_traversed') {
      if (edgeId !== null && edgeIds.has(edgeId)) {
        traversedEdgeIds.add(edgeId);
        activeEdgeId = edgeId;
      }
      continue;
    }

    if (nodeId === null || !Object.hasOwn(nodeStates, nodeId)) continue;
    switch (kind) {
      case 'node_started':
        nodeStates[nodeId] = 'active';
        break;
      case 'node_completed':
        if (outcome === 'fail') {
          nodeStates[nodeId] = 'retrying';
        } else if (outcome === 'escalate' || outcome === 'reject') {
          nodeStates[nodeId] = 'escalated';
        } else if (outcome !== null && PASSED_OUTCOMES.has(outcome)) {
          nodeStates[nodeId] = 'passed';
        }
        break;
      case 'node_failed':
      case 'loop_limit_reached':
        nodeStates[nodeId] = 'failed';
        break;
    }
  }

  return {
    nodeStates,
    activeEdgeIds: new Set(activeEdgeId === null ? [] : [activeEdgeId]),
    traversedEdgeIds,
    currentEvent,
  };
}
