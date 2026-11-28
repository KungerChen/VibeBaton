import type { Edge } from '@xyflow/react';
import type { RunHandoff } from '../api/client';

const TASK_NODE_PREFIX = 'live-task-';
const MILESTONE_NODE_PREFIX = 'live-ms-';

/** The handoff end (`planner`, `task:<id>`, `milestone:<id>`, `final_gate`) behind a live graph node id. */
export function handoffRefFromNodeId(nodeId: string): string | null {
  if (nodeId === 'live-planner') return 'planner';
  if (nodeId === 'live-final-gate') return 'final_gate';
  if (nodeId.startsWith(TASK_NODE_PREFIX) && nodeId.length > TASK_NODE_PREFIX.length) {
    return `task:${nodeId.slice(TASK_NODE_PREFIX.length)}`;
  }
  if (nodeId.startsWith(MILESTONE_NODE_PREFIX) && nodeId.length > MILESTONE_NODE_PREFIX.length) {
    return `milestone:${nodeId.slice(MILESTONE_NODE_PREFIX.length)}`;
  }
  return null;
}

/** The server handoff id (`<from>><to>`) for a live graph edge; panel edges have none. */
export function handoffIdForEdge(source: string, target: string): string | null {
  const from = handoffRefFromNodeId(source);
  const to = handoffRefFromNodeId(target);
  return from && to ? `${from}>${to}` : null;
}

/** The handoff the server listed for this edge, if any. */
export function handoffForEdge(
  edge: Pick<Edge, 'source' | 'target'>,
  handoffs: readonly RunHandoff[] | null,
): RunHandoff | null {
  const id = handoffIdForEdge(edge.source, edge.target);
  return (id && handoffs?.find((handoff) => handoff.id === id)) || null;
}

export const UNRECORDED_EDGE_STYLE = { strokeDasharray: '6 5', opacity: 0.55 } as const;

/**
 * Edges backed by a recorded handoff keep the live look. Every other edge (not recorded, not listed,
 * or the list not loaded yet) is dashed and faded, and never shows as active or already walked.
 */
export function relayEdges(
  edges: readonly Edge[],
  handoffs: readonly RunHandoff[] | null,
  activeEdgeIds: ReadonlySet<string>,
  traversedEdgeIds: ReadonlySet<string>,
): { edges: Edge[]; activeEdgeIds: Set<string>; traversedEdgeIds: Set<string> } {
  const active = new Set<string>();
  const traversed = new Set<string>();
  const styled = edges.map((edge) => {
    const recorded = handoffForEdge(edge, handoffs)?.recorded === true;
    if (recorded) {
      if (activeEdgeIds.has(edge.id)) active.add(edge.id);
      if (traversedEdgeIds.has(edge.id)) traversed.add(edge.id);
      return { ...edge, data: { ...edge.data, recorded: true } };
    }
    return {
      ...edge,
      className: 'guided-relay__edge--unrecorded',
      style: { ...edge.style, ...UNRECORDED_EDGE_STYLE },
      data: { ...edge.data, recorded: false },
    };
  });
  return { edges: styled, activeEdgeIds: active, traversedEdgeIds: traversed };
}
