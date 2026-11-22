import type { Edge } from '@xyflow/react';
import type { BatonFlowNode } from '../components/nodes/BatonNode';
import type { ExecutionState, WorkflowGraph, WorkflowNode } from '../types/graph';

function layoutDepths(graph: WorkflowGraph): Map<string, number> {
  const outgoing = new Map<string, string[]>(graph.nodes.map(({ id }) => [id, []]));
  const incoming = new Set<string>();

  for (const { source, target, max_loops } of graph.edges) {
    const successors = outgoing.get(source);
    if (!successors || !outgoing.has(target)) continue;
    successors.push(target);
    // Declared feedback does not disqualify a workflow entry.
    if (max_loops === undefined) incoming.add(target);
  }

  const depths = new Map<string, number>();
  const queue: { id: string; depth: number }[] = [];
  let cursor = 0;

  function enqueue(id: string, depth: number) {
    if (depths.has(id)) return;
    depths.set(id, depth);
    queue.push({ id, depth });
  }

  function visitQueuedNodes() {
    while (cursor < queue.length) {
      const { id, depth } = queue[cursor++];
      for (const target of outgoing.get(id)!) enqueue(target, depth + 1);
    }
  }

  for (const id of outgoing.keys()) {
    if (!incoming.has(id)) enqueue(id, 0);
  }
  visitQueuedNodes();

  // Give each remaining region a starting point, including cycles without an entry.
  for (const id of outgoing.keys()) {
    enqueue(id, 0);
    visitQueuedNodes();
  }

  return depths;
}

function editableConfig(config: WorkflowNode['config']) {
  const { provider, model, max_loops, concurrency, pinned, assigned_model } = config ?? {};
  return {
    provider: typeof provider === 'string' ? provider : undefined,
    model: typeof model === 'string' ? model : undefined,
    max_loops: typeof max_loops === 'number' ? max_loops : undefined,
    concurrency: typeof concurrency === 'number' ? concurrency : undefined,
    pinned: typeof pinned === 'boolean' ? pinned : undefined,
    assigned_model: typeof assigned_model === 'string' ? assigned_model : undefined,
  };
}

function omitUndefined<T extends object>(record: T): T {
  for (const key of Object.keys(record) as (keyof T)[]) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

export function graphToFlow(
  graph: WorkflowGraph,
  states?: Record<string, ExecutionState>,
): { nodes: BatonFlowNode[]; edges: Edge[] } {
  const depths = graph.nodes.some((node) => node.position === undefined) ? layoutDepths(graph) : undefined;
  const lanes = new Map<number, number>();

  const nodes = graph.nodes.map<BatonFlowNode>((node) => {
    const depth = depths?.get(node.id) ?? 0;
    const lane = lanes.get(depth) ?? 0;
    lanes.set(depth, lane + 1);

    return {
      id: node.id,
      type: 'baton',
      position: node.position ? { ...node.position } : { x: depth * 300, y: lane * 160 },
      data: omitUndefined({
        label: node.label,
        nodeType: node.type,
        role: node.role,
        ...editableConfig(node.config),
        state: states?.[node.id] ?? 'idle',
      }),
    };
  });

  const edges = graph.edges.map<Edge>(({ id, source, target, sourceHandle, targetHandle, max_loops, condition }) => ({
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    label: sourceHandle === 'out' || sourceHandle === 'dag' ? undefined : sourceHandle,
    data: { max_loops, condition },
  }));

  return { nodes, edges };
}

export function flowToGraph(base: WorkflowGraph, nodes: BatonFlowNode[], edges: Edge[]): WorkflowGraph {
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));

  return omitUndefined({
    ...base,
    nodes: nodes.map(({ id, position, data }) => {
      const baseConfig = baseNodes.get(id)?.config;
      const original = editableConfig(baseConfig);
      const config = { ...baseConfig };
      // Only replace fields that the canvas can represent or that were edited there.
      for (const key of ['provider', 'model', 'max_loops', 'pinned', 'assigned_model'] as const) {
        if (Object.hasOwn(data, key) || original[key] !== undefined) config[key] = data[key];
      }
      omitUndefined(config);

      return omitUndefined({
        id,
        type: data.nodeType,
        label: data.label,
        role: data.role,
        position: { x: position.x, y: position.y },
        config: baseConfig !== undefined || Object.keys(config).length > 0 ? config : undefined,
      });
    }),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle, data }) => omitUndefined({
      id,
      source,
      target,
      sourceHandle: sourceHandle ?? undefined,
      targetHandle: targetHandle ?? undefined,
      max_loops: typeof data?.max_loops === 'number' ? data.max_loops : undefined,
      condition: typeof data?.condition === 'string' ? data.condition : undefined,
    })),
  });
}
