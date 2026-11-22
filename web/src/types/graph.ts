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

export type PresetCategory = 'same_family' | 'bulk_batch' | 'small_project' | 'audit' | 'general';
export type CostTier = 'low' | 'medium' | 'high';
export type BudgetProfile = 'eco' | 'balanced' | 'max_quality';

export interface WorkflowGraph {
  schema_version: string;
  id: string;
  name: string;
  difficulty?: string;
  description?: string;
  recommended_for?: string[];
  category?: PresetCategory;
  required_providers?: string[];
  cost_tier?: CostTier;
  inspired_by?: string | null;
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
  path?: string;
  node_count: number;
  edge_count: number;
  // Catalog responses include this metadata. Bare graph summaries may omit it.
  category?: PresetCategory;
  required_providers?: string[];
  cost_tier?: CostTier;
  inspired_by?: string | null;
  host_ready?: boolean;
  missing_providers?: string[];
  valid: boolean;
  errors: string[];
  warnings: string[];
  graph: WorkflowGraph;
}

export interface ModelCapability {
  provider: string;
  model: string;
  efforts: string[];
  // The model catalog uses the allocator's cost tiers.
  cost_tier: 'eco' | 'standard' | 'flagship';
  ready: boolean;
  detail: string;
}

export interface ProviderHealthSummary {
  provider: string;
  ok: boolean;
  detail: string;
  latency_ms?: number;
  install_hint?: string;
}

export interface CredentialStatus {
  provider_key: string;
  configured: boolean;
  source: 'env' | 'local_file' | 'none';
  masked: string;
}

export interface RfcReadinessResult {
  score: number;
  safe_for_overnight: boolean;
  missing_sections: string[];
  warnings: string[];
  detected_commands: string[];
}

export interface RfcBrainstormRequest {
  goal: string;
  constraints?: string;
  acceptance_cmd?: string;
  non_goals?: string;
}

export interface RfcBrainstormResult {
  rfc_markdown: string;
  readiness: RfcReadinessResult;
}

export interface DoctorRoleRequest {
  provider?: string;
  role?: string;
  model?: string;
}

export interface DoctorRoleResult extends ProviderHealthSummary {
  latency_ms: number;
  install_hint: string;
}

export interface RoleConfig {
  provider: string;
  model: string;
  fallback: string[];
}

export interface BudgetConfigResponse {
  budget_profile: BudgetProfile;
  model_catalog: ModelCapability[];
}

export interface RolesConfigResponse extends BudgetConfigResponse {
  config_path: string;
  providers: Record<string, { max_concurrency: number; command: string[] }>;
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
