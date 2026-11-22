import { NODE_TYPES, SCENARIOS } from '../types/graph';
import type {
  GraphTraceEvent,
  GraphValidationResult,
  NodeType,
  Scenario,
  SimulationResult,
  TraceKind,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from '../types/graph';

// Python includes booleans in its numeric loop-limit checks.
type LoopLimit = number | boolean;

interface SimulationEdge extends Pick<WorkflowEdge, 'id' | 'source' | 'target'> {
  sourceHandle: string;
  targetHandle: string;
  maxLoops: LoopLimit | undefined;
}

type EdgeInput = WorkflowEdge & Partial<Record<'source_handle' | 'target_handle' | 'maxLoops', unknown>>;
type Adjacency = Map<string, SimulationEdge[]>;

interface GraphAnalysis {
  validation: GraphValidationResult;
  nodes: Map<string, WorkflowNode>;
  outgoing: Adjacency;
  incoming: Adjacency;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredFieldsError(
  value: unknown,
  path: string,
  fields: Record<string, 'str' | 'list'>,
): string | undefined {
  if (!isObject(value)) return `${path} must be a JSON object`;
  for (const [name, type] of Object.entries(fields)) {
    if (!Object.hasOwn(value, name)) return `${path} is missing required field '${name}'`;
    if (type === 'str' ? typeof value[name] !== 'string' : !Array.isArray(value[name])) {
      return `${path}.${name} must have type ${type}`;
    }
  }
}

function parseGraphEdges(graph: WorkflowGraph): SimulationEdge[] | string {
  const error = requiredFieldsError(graph, 'Workflow graph', {
    schema_version: 'str', id: 'str', name: 'str', nodes: 'list', edges: 'list',
  });
  if (error) return error;

  for (const [index, node] of graph.nodes.entries()) {
    const path = `nodes[${index}]`;
    const error = requiredFieldsError(node, path, { id: 'str', type: 'str', label: 'str' });
    if (error) return error;
    if (!NODE_TYPES.includes(node.type)) return `Unknown node type '${node.type}' at ${path}.type`;
    if (node.config !== undefined && !isObject(node.config)) return `${path}.config must be a JSON object`;
  }

  const edges: SimulationEdge[] = [];
  for (const [index, input] of graph.edges.entries()) {
    const path = `edges[${index}]`;
    const error = requiredFieldsError(input, path, { id: 'str', source: 'str', target: 'str' });
    if (error) return error;
    const edge: EdgeInput = input;
    const sourceHandle = edge.sourceHandle === undefined ? edge.source_handle : edge.sourceHandle;
    const targetHandle = edge.targetHandle === undefined ? edge.target_handle : edge.targetHandle;
    if ((sourceHandle !== undefined && typeof sourceHandle !== 'string')
      || (targetHandle !== undefined && typeof targetHandle !== 'string')) {
      return `${path} handles must be strings`;
    }
    const limit = edge.max_loops === undefined ? edge.maxLoops : edge.max_loops;
    if (limit != null && typeof limit !== 'boolean' && !(typeof limit === 'number' && Number.isInteger(limit))) {
      return `${path}.max_loops must be an integer`;
    }
    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: sourceHandle ?? 'out',
      targetHandle: targetHandle ?? 'in',
      maxLoops: limit ?? undefined,
    });
  }
  return edges;
}

function* cyclePaths(
  outgoing: Adjacency,
  follow: (edge: SimulationEdge) => boolean = () => true,
): Generator<string[]> {
  const finished = new Set<string>();
  for (const root of outgoing.keys()) {
    if (finished.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    const active = new Map([[root, 0]]);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edge = outgoing.get(frame.id)![frame.next++];
      if (!edge) {
        finished.add(frame.id);
        active.delete(frame.id);
        stack.pop();
        continue;
      }
      if (!follow(edge)) continue;
      const depth = active.get(edge.target);
      if (depth !== undefined) {
        yield [...stack.slice(depth).map(({ id }) => id), edge.target];
      } else if (!finished.has(edge.target)) {
        active.set(edge.target, stack.length);
        stack.push({ id: edge.target, next: 0 });
      }
    }
  }
}

function reachableNodes(starts: string[], neighbors: (id: string) => Iterable<string>): Set<string> {
  const pending = [...starts];
  const reached = new Set(starts);
  while (pending.length > 0) {
    for (const id of neighbors(pending.pop()!)) {
      if (reached.has(id)) continue;
      reached.add(id);
      pending.push(id);
    }
  }
  return reached;
}

function nodeLoopLimit(node: WorkflowNode): LoopLimit | undefined {
  const limit = node.config?.max_loops;
  return typeof limit === 'number' || typeof limit === 'boolean' ? limit : undefined;
}

const feedbackHandles = new Set(['fail', 'minor_fix', 'retry']);

function analyzeGraph(graph: WorkflowGraph): GraphAnalysis {
  const validation: GraphValidationResult = {
    valid: false, errors: [], warnings: [], entry_nodes: [], has_cycles: false,
  };
  const { errors, warnings, entry_nodes } = validation;
  const nodes = new Map<string, WorkflowNode>();
  const outgoing: Adjacency = new Map();
  const incoming: Adjacency = new Map();
  const analysis = { validation, nodes, outgoing, incoming };
  const edges = parseGraphEdges(graph);
  if (typeof edges === 'string') {
    errors.push(edges);
    return analysis;
  }

  if (graph.nodes.length === 0) errors.push('Workflow graph must contain at least one node');
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) errors.push(`Duplicate node id '${node.id}'`);
    nodes.set(node.id, node);
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }

  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) errors.push(`Duplicate edge id '${edge.id}'`);
    edgeIds.add(edge.id);
    const sources = outgoing.get(edge.source);
    const targets = incoming.get(edge.target);
    if (!sources) errors.push(`Edge '${edge.id}' has dangling source '${edge.source}'`);
    if (!targets) errors.push(`Edge '${edge.id}' has dangling target '${edge.target}'`);
    if (sources && targets) {
      sources.push(edge);
      targets.push(edge);
    }
  }

  const entries = new Set([...nodes.keys()].filter((id) => incoming.get(id)!.length === 0));
  const successors = (id: string) => outgoing.get(id)!.map((edge) => edge.target);
  const reached = reachableNodes([...entries], successors);

  // A disconnected cycle can start where every incoming edge is marked feedback
  // and returns from downstream of that candidate entry.
  for (const [id, inputs] of incoming) {
    if (reached.has(id) || inputs.some((edge) => edge.maxLoops === undefined
      && edge.targetHandle !== 'fix' && !feedbackHandles.has(edge.sourceHandle))) continue;
    const downstream = reachableNodes([id], successors);
    if (inputs.every((edge) => downstream.has(edge.source))) {
      entries.add(id);
      for (const nodeId of downstream) reached.add(nodeId);
    }
  }

  if (entries.size === 0) errors.push('Workflow graph has no entry nodes');
  for (const id of nodes.keys()) {
    if (entries.has(id)) entry_nodes.push(id);
    if (!reached.has(id)) warnings.push(`Unreachable node '${id}'`);
  }

  validation.has_cycles = !cyclePaths(outgoing).next().done;
  if (validation.has_cycles) {
    const boundedNodes = new Set(
      [...nodes.values()].filter((node) => Number(nodeLoopLimit(node) ?? 0) >= 1).map(({ id }) => id),
    );
    const isUnbounded = (edge: SimulationEdge) => Number(edge.maxLoops ?? 0) < 1
      && !boundedNodes.has(edge.source) && !boundedNodes.has(edge.target);
    for (const path of cyclePaths(outgoing, isUnbounded)) {
      errors.push(`Unbounded cycle without max_loops >= 1: ${path.join(' -> ')}`);
    }
  }
  validation.valid = errors.length === 0;
  return analysis;
}

export function validateGraph(graph: WorkflowGraph): GraphValidationResult {
  return analyzeGraph(graph).validation;
}

// Preferred outcomes match _MOCK_OUTCOMES in graph_engine.py.
const mockOutcomes: Record<NodeType, readonly [string, ...string[]]> = {
  planner_node: ['out'],
  router_node: ['routine', 'critical', 'out'],
  worker_node: ['out'],
  gate_node: ['pass', 'out'],
  reviewer_node: ['pass', 'out'],
  merge_node: ['out'],
  human_gate_node: ['approve', 'out'],
};

function mockOutcome(
  type: NodeType,
  handles: string[],
  scenario: Scenario,
  attempt: number,
): string {
  let preferences = mockOutcomes[type];
  if (attempt === 1) {
    if (type === 'gate_node' && scenario === 'gate_retry') {
      preferences = ['fail', ...preferences];
    } else if (type === 'reviewer_node' && scenario === 'escalate' && handles.length > 0) {
      preferences = ['escalate', 'minor_fix', ...preferences];
    }
  }
  return preferences.find((handle) => handles.includes(handle)) ?? handles[0] ?? preferences[0];
}

interface Route {
  edge: SimulationEdge;
  outcome: string;
}

function routesFor(type: NodeType, edges: SimulationEdge[], outcome: string, scenario: Scenario): Route[] {
  const matching = (handle: string) => edges.filter((edge) => edge.sourceHandle === handle);

  let selected = matching(outcome);
  if (selected.length === 0) {
    selected = edges.filter((edge) => edge.sourceHandle === 'out' || edge.sourceHandle === '*');
  }
  const routes = selected.map((edge) => ({ edge, outcome }));
  if (scenario === 'happy_path' && type === 'router_node' && outcome === 'routine') {
    routes.push(...matching('critical').map((edge) => ({ edge, outcome: 'critical' })));
  }
  return routes;
}

function mergeJoinAncestors(nodes: Map<string, WorkflowNode>, incoming: Adjacency): Map<string, Set<string>> {
  const joins = new Map<string, Set<string>>();
  const predecessors = (id: string) => incoming.get(id)!.map((edge) => edge.source);
  for (const [id, node] of nodes) {
    if (node.type !== 'merge_node' || incoming.get(id)!.length < 2) continue;
    const ancestors = reachableNodes(predecessors(id), predecessors);
    if (!ancestors.has(id)) joins.set(id, ancestors);
  }
  return joins;
}

function loopLimit(edge: SimulationEdge, cycle: string[], nodes: Map<string, WorkflowNode>): LoopLimit | undefined {
  if (edge.maxLoops !== undefined || cycle.length === 0) return edge.maxLoops;
  // The Python engine checks the source first, then the cycle from the target back to the source.
  for (const id of [edge.source, ...cycle.slice(0, -1)]) {
    const limit = nodeLoopLimit(nodes.get(id)!);
    if (limit !== undefined) return limit;
  }
}

interface Visit {
  id: string;
  ancestors: string[];
}

const MAX_STEPS = 500;

export function simulateGraph(graph: WorkflowGraph, scenario: Scenario): SimulationResult {
  const visited_nodes: string[] = [];
  const trace: GraphTraceEvent[] = [];
  let activeNode: string | null = null;

  function emit(
    kind: TraceKind,
    node_id: string | null = null,
    edge_id: string | null = null,
    outcome: string | null = null,
    message = '',
  ): void {
    const seq = trace.length + 1;
    // Demo playback uses elapsed time. The backend reports wall-clock timestamps.
    trace.push({ seq, timestamp: seq * 0.01, kind, node_id, edge_id, outcome, message });
  }

  function halt(message: string): SimulationResult {
    emit('graph_halted', null, null, null, message);
    return { status: 'halted', visited_nodes, trace };
  }

  try {
    if (!SCENARIOS.includes(scenario)) {
      throw new Error(`Unknown simulation scenario '${scenario}'. Choose from ${SCENARIOS.join(', ')}.`);
    }
    const { validation, nodes, outgoing, incoming } = analyzeGraph(graph);
    if (!validation.valid) throw new Error(`Invalid workflow graph:\n${validation.errors.join('\n')}`);

    let pending: Visit[] = validation.entry_nodes.map((id) => ({ id, ancestors: [] }));
    const attempts = new Map<string, number>();
    const traversals = new Map<string, number>();
    const joins = scenario === 'happy_path' ? mergeJoinAncestors(nodes, incoming) : undefined;

    while (pending.length > 0) {
      if (visited_nodes.length >= MAX_STEPS) return halt(`Reached max_steps=${MAX_STEPS}`);
      const visit = pending.shift()!;
      const { id, ancestors } = visit;
      const upstream = joins?.get(id);
      if (upstream) {
        if (pending.some((other) => upstream.has(other.id))) {
          pending.push(visit);
          continue;
        }
        pending = pending.filter((other) => other.id !== id);
      }

      activeNode = id;
      const path = [...ancestors, id];
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      visited_nodes.push(id);
      emit('node_started', id);

      const { type } = nodes.get(id)!;
      const edges = outgoing.get(id)!;
      const handles = edges.map((edge) => edge.sourceHandle);
      const outcome = mockOutcome(type, handles, scenario, attempt);
      emit('node_completed', id, null, outcome);

      let limitReached = false;
      for (const route of routesFor(type, edges, outcome, scenario)) {
        const { edge } = route;
        const targetIndex = path.indexOf(edge.target);
        const cycleStart = targetIndex === -1 ? path.length : targetIndex;
        const limit = loopLimit(edge, path.slice(cycleStart), nodes);
        if (limit !== undefined) {
          const count = (traversals.get(edge.id) ?? 0) + 1;
          if (count > Number(limit)) {
            const label = typeof limit === 'boolean' ? (limit ? 'True' : 'False') : limit;
            emit('loop_limit_reached', id, edge.id, route.outcome, `Traversal limit ${label} reached`);
            limitReached = true;
            continue;
          }
          traversals.set(edge.id, count);
        }
        emit('edge_traversed', id, edge.id, route.outcome);
        // A return starts a fresh pass through the cycle from its target.
        pending.push({ id: edge.target, ancestors: path.slice(0, cycleStart) });
      }
      if (limitReached && pending.length === 0) return halt('No queued nodes remain after reaching a loop limit');
      activeNode = null;
    }

    emit('graph_completed');
    return { status: 'completed', visited_nodes, trace };
  } catch (error) {
    emit('node_failed', activeNode, null, null, error instanceof Error ? error.message : String(error));
    return { status: 'failed', visited_nodes, trace };
  }
}
