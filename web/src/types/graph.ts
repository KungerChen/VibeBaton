export type NodeType =
  | 'planner_node'
  | 'router_node'
  | 'worker_node'
  | 'gate_node'
  | 'reviewer_node'
  | 'merge_node'
  | 'human_gate_node';

export const NODE_TYPES: readonly NodeType[] = [
  'planner_node',
  'router_node',
  'worker_node',
  'gate_node',
  'reviewer_node',
  'merge_node',
  'human_gate_node',
];

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  role?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  max_loops?: number;
  condition?: string;
}

export interface WorkflowGraph {
  schema_version: string;
  id: string;
  name: string;
  difficulty?: string;
  description?: string;
  recommended_for?: string[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface GraphValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  entry_nodes: string[];
  has_cycles: boolean;
}

export type TraceKind =
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'edge_traversed'
  | 'loop_limit_reached'
  | 'graph_completed'
  | 'graph_halted';

export interface GraphTraceEvent {
  seq: number;
  timestamp: number;
  kind: TraceKind;
  node_id: string | null;
  edge_id: string | null;
  outcome: string | null;
  message: string;
}

export type Scenario = 'happy_path' | 'gate_retry' | 'escalate';

export const SCENARIOS: readonly Scenario[] = ['happy_path', 'gate_retry', 'escalate'];

export interface SimulationResult {
  status: 'completed' | 'halted' | 'failed';
  visited_nodes: string[];
  trace: GraphTraceEvent[];
}

export interface PresetItem {
  id: string;
  name: string;
  difficulty: string;
  description: string;
  recommended_for: string[];
  node_count: number;
  edge_count: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
  graph: WorkflowGraph;
}

export interface RoleConfig {
  provider: string;
  model: string;
  fallback: string[];
}

export interface RolesConfigResponse {
  config_path: string;
  providers: Record<string, { max_concurrency: number; command: string }>;
  roles: Record<string, RoleConfig>;
}

export interface LiveRunSnapshot {
  run: Record<string, unknown> | null;
  milestones: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  events: Record<string, unknown>[];
  quotas: Record<string, unknown>[];
}

export type ExecutionState = 'idle' | 'active' | 'passed' | 'retrying' | 'escalated' | 'failed';

export type TierKey = 'L0' | 'L1' | 'L2' | 'L3' | 'GATE' | 'MERGE' | 'ROUTER' | 'HUMAN';

const tiersByNodeType: Record<NodeType, TierKey> = {
  planner_node: 'L1',
  router_node: 'ROUTER',
  worker_node: 'L2',
  gate_node: 'GATE',
  reviewer_node: 'L1',
  merge_node: 'MERGE',
  human_gate_node: 'HUMAN',
};

const tiersByRole = new Map<string, TierKey>([
  ['brainstorm_and_final_gate', 'L0'],
  ['tactical_planner', 'L1'],
  ['milestone_reviewer', 'L1'],
  ['critical_executor', 'L2'],
  ['micro_orchestrator', 'L2'],
  ['bulk_worker', 'L3'],
]);

export function tierForNodeType(type: NodeType, role?: string): TierKey {
  return tiersByRole.get(role ?? '') ?? tiersByNodeType[type];
}
