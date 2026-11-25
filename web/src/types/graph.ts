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

export type NodeTimingConfig = {
  duration_sec?: number;
  started_at?: number | null;
  is_timing_active?: boolean;
};

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  role?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown> & NodeTimingConfig;
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

export type PresetCategory = 'same_family' | 'bulk_batch' | 'small_project' | 'audit' | 'panel' | 'general';
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

export interface PricingModelEntry {
  model: string;
  input_per_1m: number;
  output_per_1m: number;
  cached_input_per_1m: number;
  source: 'custom' | 'official_cache' | 'builtin';
}

export interface PricingCacheStatus {
  path: string;
  fetched_at: string | null;
  age_sec: number | null;
  stale: boolean;
  refresh_interval_hours: number;
  auto_sync: boolean;
  source_url: string;
}

export interface PricingStatusResponse {
  models: PricingModelEntry[];
  cache: PricingCacheStatus;
  custom_path: string;
}

export interface PricingSyncResponse {
  ok: boolean;
  fetched: boolean;
  skipped_fresh: boolean;
  model_count: number;
  error: string | null;
  catalog: PricingStatusResponse;
}

// A null entry clears the override for that model.
export type CustomPricingUpdate = Record<
  string,
  Pick<PricingModelEntry, 'input_per_1m' | 'output_per_1m' | 'cached_input_per_1m'> | null
>;

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

/** Run modes accepted by POST /api/runs/start; 'panel' runs 00_PANEL before planning. */
export type LaunchRunMode = 'overnight' | 'interactive' | 'panel';

export interface LaunchRunRequest {
  rfc_path?: string;
  rfc_markdown?: string;
  mode?: LaunchRunMode;
  model_overrides?: Record<string, string>;
  /** Role name -> provider id (the Guided Ready-on-Host lineup); the server maps it to provider:model overrides. */
  role_providers?: Record<string, string>;
}

export interface RunListItem {
  id: string;
  status: string;
  mode: string;
  created_at: number | null;
  updated_at: number | null;
  finished_at: number | null;
  elapsed_sec: number;
  passed_tasks: number;
  total_tasks: number;
  passed_milestones: number;
  total_milestones: number;
}

export interface StageTelemetry {
  id: string;
  kind: 'panel' | 'planning' | 'milestone';
  title: string;
  status: string;
  wall_sec: number;
  task_sum_sec: number;
  passed_tasks: number;
  total_tasks: number;
  started_at?: number | null;
  is_active?: boolean;
}

export interface ModelTelemetry {
  actor: string;
  role: string;
  provider: string;
  display_provider: string;
  model: string;
  calls: number;
  duration_sec: number;
  estimated: boolean;
  avg_sec: number;
  share_pct: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number | null;
  active_started_at?: number | null;
}

export interface BillingTelemetry {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cached_tokens: number;
  total_tokens: number;
  total_cost_usd: number | null;
  has_exact_billing: boolean;
}

export interface TaskTiming {
  /** Recorded duration or estimated work through the snapshot. */
  duration_sec: number;
  /** Unix timestamp in seconds of the active invocation, when available. */
  started_at: number | null;
  is_active: boolean;
}

export type AttentionSeverity = 'warning' | 'error' | 'info';
export type AttentionCategory = 'waiting_human' | 'ready_for_final_gate' | 'failed' | 'paused' | 'long_cooldown';

export interface RunAttentionState {
  category: AttentionCategory;
  severity: AttentionSeverity;
  title: string;
  message: string;
  action_hint: string;
  milestone_id: string | null;
  task_id: string | null;
  created_at: string | number | null;
}

export interface RunTelemetry {
  elapsed_sec: number;
  stages: StageTelemetry[];
  models: ModelTelemetry[];
  billing?: BillingTelemetry | null;
  conflicts?: {
    conflicts_detected: number;
    conflicts_auto_resolved: number;
    conflicts_failed: number;
  } | null;
  /** Unix timestamp in seconds when the server computed this snapshot. */
  server_now?: number;
  task_timings?: Record<string, TaskTiming>;
  attention?: RunAttentionState | null;
}

export interface LiveRunSnapshot {
  run: Record<string, unknown> | null;
  milestones: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  events: Record<string, unknown>[];
  quotas: Record<string, unknown>[];
  telemetry?: RunTelemetry | null;
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

export interface CaseRedactionReport {
  secrets_redacted: number;
  paths_anonymized: number;
  emails_redacted: number;
  ips_redacted: number;
  raw_diff_stripped: number;
  raw_stack_stripped: number;
  clean: boolean;
}

export interface CaseReplayMeta {
  source_run_id: string;
  status: string;
  elapsed_sec: number;
  milestones_passed: number;
  milestones_total: number;
  tasks_passed: number;
  tasks_total: number;
  gate_catches: number;
  whitelist_catches: number;
  escalations: number;
  /** Model names after normalizing the backend's provider/model entries. */
  models: string[];
  stages: unknown[];
  billing: Record<string, unknown>;
}

export interface BatonCaseBundle {
  schema_version: 'baton-case/v1';
  case_id: string;
  title: string;
  summary: string;
  created_at: string;
  meta: CaseReplayMeta;
  redaction_report: CaseRedactionReport;
  graph: WorkflowGraph;
  trace: GraphTraceEvent[];
  isOfficialTutorial?: boolean;
}
