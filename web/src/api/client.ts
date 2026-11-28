import { DEMO_ROLES_CONFIG, demoProviderHealth } from '../data/demoConfig';
import { PRESET_REGISTRY, findPreset, presetToItem } from '../data/presets';
import { buildOfficialStage1Case, parseAndValidateCaseBundle } from '../engine/caseReplay';
import { simulateGraph, validateGraph } from '../engine/localSimulator';
import type {
  BatonCaseBundle,
  BudgetConfigResponse,
  BudgetProfile,
  CredentialStatus,
  CustomPricingUpdate,
  DoctorRoleRequest,
  DoctorRoleResult,
  GraphValidationResult,
  LaunchRunRequest,
  LiveRunSnapshot,
  PresetItem,
  PricingCacheStatus,
  PricingModelEntry,
  PricingStatusResponse,
  PricingSyncResponse,
  RfcReadinessResult,
  RoleConfig,
  RolesConfigResponse,
  RunListItem,
  Scenario,
  SimulationResult,
  WorkflowGraph,
} from '../types/graph';
import { checkRfcReadiness } from './offlineRfc';

export type ApiMode = 'local' | 'demo';

/** Known error details are retained alongside any future server fields. */
export interface ApiErrorDetails {
  error?: string;
  code?: string;
  codes?: string[];
  conflicts?: string[];
  base_head?: string;
  gates?: GateCommandResult[];
  fallback?: WorkflowRecommendation;
  merged_commit?: string;
  guidance?: string;
  run_id?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly data?: ApiErrorDetails) {
    super(message);
    this.name = 'ApiError';
  }

  get code(): string | undefined {
    return typeof this.data?.code === 'string' ? this.data.code : undefined;
  }
}

type WireRoleConfig = Omit<RoleConfig, 'fallback'> & {
  fallback: (string | { provider: string; model: string })[];
};

type WireRolesConfigResponse = Omit<RolesConfigResponse, 'roles'> & {
  roles: Record<string, WireRoleConfig>;
};

type WirePricingStatusResponse = Omit<PricingStatusResponse, 'cache'> & {
  cache: PricingCacheStatus | (Omit<PricingCacheStatus, 'fetched_at'> & { fetched_at: number });
};

type WirePricingSyncResponse = Omit<PricingSyncResponse, 'catalog'> & {
  catalog: WirePricingStatusResponse;
};

export type RunDecision = 'approve' | 'reject';

// Guided Studio payloads. These mirror the M1 backend contracts in
// src/vibebaton/cli_registry.py, src/vibebaton/brainstorm.py and src/vibebaton/web_server.py.

export type CliDriverTier = 'official' | 'community';
export type CliScanStatus = 'ready' | 'installed_unauthenticated' | 'missing' | 'prereq_missing';

export interface CliDriver {
  id: string;
  name: string;
  tier: CliDriverTier;
  binary: string;
  summary_en: string;
  summary_zh: string;
  prereq: string[];
  install_cmd: string[];
  login_cmd: string[];
  official_url: string;
  command_template: string[];
  version_cmd: string[];
  provider_ids: string[];
  env_keys: string[];
  auth_check_cmd?: string[] | null;
}

export interface CliTag {
  id: string;
  label_en: string;
  label_zh: string;
  summary_en: string;
  summary_zh: string;
}

export interface CliRegistry {
  schema_version: number;
  drivers: CliDriver[];
  tags: CliTag[];
}

export interface CliScanEntry {
  id: string;
  status: CliScanStatus;
  binary_path: string | null;
  version: string | null;
  prereq_missing: string[];
  reason_en: string;
  reason_zh: string;
}

export interface CliScanResult {
  drivers: CliScanEntry[];
  http_api_keys_present: string[];
  /** Unix seconds. */
  scanned_at: number;
}

export interface RecommendedLineup {
  ready: boolean;
  /** Role name -> provider id. */
  roles: Record<string, string>;
  /** Optional role name -> "provider:model@effort" override chosen by the user. */
  model_overrides?: Record<string, string>;
  /** True when the user changed the recommended team by hand. */
  customized?: boolean;
  source: 'cli' | 'http' | 'mixed';
  notes_en: string;
  notes_zh: string;
}

export interface SavedLineupProfile {
  id: string;
  name: string;
  roles: Record<string, string>;
  model_overrides: Record<string, string>;
  updated_at: number;
}

export interface LastUsedLineup {
  roles: Record<string, string>;
  model_overrides: Record<string, string>;
  profile_id: string | null;
  profile_name: string | null;
  updated_at: number;
}

export interface LineupProfilesResponse {
  profiles: SavedLineupProfile[];
  last_used: LastUsedLineup | null;
  /** Saved settings the server just corrected (shown once; the fix is already saved). */
  corrections?: EffortCorrection[];
}

export interface SaveLineupProfileResponse extends LineupProfilesResponse {
  profile: SavedLineupProfile;
}

export interface ModelCatalogEntry {
  id: string;
  label: string;
  family: string;
  providers: string[];
  status: 'latest' | 'legacy' | 'synced';
  cost_tier: 'flagship' | 'standard' | 'eco';
  rank: number;
  efforts: string[];
  default_effort: string;
  /** Allowed efforts per provider; an empty list means the tool takes no effort at all. */
  provider_efforts?: Record<string, string[]>;
  /** Where each provider's list came from: a tool's own list, a tool declaration, feed flags, or a default. */
  effort_sources?: Record<string, 'cli_models' | 'cli_declared' | 'feed' | 'default'>;
  /** Each provider's legal default effort ("" when it takes none). */
  provider_defaults?: Record<string, string>;
}

/** A saved setting the server changed because its tool does not offer that effort. */
export interface EffortCorrection {
  where?: string;
  role: string;
  before: string;
  after: string;
  reason: string;
}

export interface TierRecommendation {
  providers: string[];
  model: string;
  effort: string;
  /** Served by the catalog: each listed provider's legal effort in the current catalog ("" = none). */
  efforts_by_provider?: Record<string, string>;
  note_en: string;
  note_zh: string;
}

export interface ModelCatalogResponse {
  models: ModelCatalogEntry[];
  tier_recommendations: Record<string, TierRecommendation[]>;
  role_tiers: Record<string, string>;
  efforts: { id: string; label: string }[];
  cache: {
    path: string;
    fetched_at: number | null;
    age_sec: number | null;
    stale: boolean;
    /** Last background sync failure; cleared after the next successful fetch. */
    last_error?: string | null;
    refresh_interval_hours: number;
  };
}

export interface ModelCatalogSyncResponse {
  ok: boolean;
  fetched: boolean;
  skipped_fresh: boolean;
  added_count: number;
  error: string | null;
  catalog: ModelCatalogResponse;
}

export interface CliRegistryScanResponse {
  scan: CliScanResult;
  lineup: RecommendedLineup;
}

export interface CliInstallRequest {
  cliId: string;
  /** Installing runs a registry recipe on the host, so callers must confirm explicitly. */
  confirmed: true;
}

export interface CliInstallResult {
  id: string;
  ok: boolean;
  command: string[];
  returncode: number;
  output: string;
}

export interface CliLoginResult {
  id: string;
  launched: boolean;
  command: string[];
  message_en: string;
  message_zh: string;
}

export interface WorkspaceInfo {
  path: string;
  is_git_repo: boolean;
  branch: string | null;
  has_commits: boolean;
  has_rfc: boolean;
}

export interface BrowseWorkspaceResult {
  cancelled: boolean;
  path: string | null;
  workspace: WorkspaceInfo;
}

export interface InitGitResult extends WorkspaceInfo {
  created: boolean;
}

export interface BrainstormMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BrainstormChatRequest {
  /** Full conversation so far, oldest first; must end with a user message. */
  messages: BrainstormMessage[];
  scenario?: string | null;
  offline?: boolean;
  locale?: 'en' | 'zh';
  /** The Guided lineup's L0 choice: `{brainstorm_and_final_gate: "provider:model@effort"}`. */
  model_overrides?: Record<string, string>;
  /** The Guided lineup's L0 provider when it has no explicit model. */
  role_providers?: Record<string, string>;
  requested_l0_model?: string | null;
  latest_rfc_draft?: string;
  revision_context?: RevisionContext | null;
  /** Backwards-compatible server alias for revision_context. */
  revision?: RevisionContext | null;
  failure_context?: string;
  previous_lineup?: WorkflowLineup | null;
}

export interface RevisionContext {
  prior_rfc: string;
  requested_changes: string;
  failure_context?: string | null;
}

export interface BlueprintCard {
  title: string;
  summary: string;
  deliverables: string[];
  touched_areas: string[];
  verification_plan: string[];
  /** 0-100, equals the RFC readiness score. */
  readiness_score: number;
  ready_to_launch: boolean;
}

export interface BrainstormTurnResult {
  reply: string;
  rfc_markdown: string;
  blueprint: BlueprintCard;
  /** null when the deterministic offline composer produced the turn. */
  provider_used: string | null;
  offline: boolean;
  guide: BrainstormGuide;
  /** Sanitized reason for an offline fallback or a protected-draft retry. */
  error: string | null;
  requested_model?: string | null;
  responding_model?: string | null;
  retryable?: boolean;
  recommendation?: WorkflowRecommendation;
}

export type ChecklistId = 'what' | 'who' | 'scope' | 'limits' | 'done';
export type ChecklistStatus = 'clear' | 'assumed' | 'open';

export interface ChecklistItem {
  id: ChecklistId;
  status: ChecklistStatus;
  /** One plain sentence; empty while the item is open. */
  value: string;
}

export interface BrainstormGuide {
  /** The single question of this turn; empty when nothing is left to ask. */
  question: string;
  /** 0-4 clickable answers; the page adds its own "not sure" button. */
  options: string[];
  /** Always the five ids, in order: what, who, scope, limits, done. */
  checklist: ChecklistItem[];
  size?: ProjectSize | null;
}

export type ProjectSize = 'small' | 'medium' | 'large';
export type WorkflowMode = 'interactive' | 'overnight' | 'panel';
export interface WorkflowLineup {
  roles: Record<string, string>;
  model_overrides: Record<string, string>;
  size?: ProjectSize;
  /** True once the user changed this team by hand; recommendations then keep it. */
  customized?: boolean;
}

export interface WorkflowRecommendation {
  mode: WorkflowMode;
  preset: string | null;
  lineup: WorkflowLineup | null;
  size: ProjectSize | null;
  reason_code: string;
  explanation_key: string;
  fallback: boolean;
  size_changed: boolean | null;
  explanation_codes: string[];
  substitutions: { role: string; preferred_provider: string; chosen_provider: string }[];
  /** Panelist providers that are not ready (a large project then skips the panel recommendation). */
  missing_panelists?: string[];
  /** Saved team settings whose effort was not offered and was changed. */
  effort_changes?: EffortCorrection[];
  /** The plan flow for this RFC when launched as recommended with the lean switch on (absent in older sessions). */
  flow?: 'lean' | 'full';
  flow_reason?: string;
}

/** POST /api/guided/recommend: the chat's recommendation, for RFC text the user brought. */
export interface GuidedRecommendResult {
  recommendation: WorkflowRecommendation;
  readiness: RfcReadinessResult;
}

export type GuidedStage = 'setup' | 'blueprint' | 'build' | 'signoff';
export interface GuidedSession {
  schema_version: number;
  active_stage: GuidedStage;
  workspace_path: string | null;
  brainstorm: {
    messages: BrainstormMessage[];
    checklist: ChecklistItem[];
    latest_rfc_draft: string;
    selected_l0_model: string | null;
    has_online_draft: boolean;
    [key: string]: unknown;
  };
  workflow: {
    mode: WorkflowMode | null;
    lineup: WorkflowLineup;
    preset: string | null;
    panel_enabled: boolean;
    launch_request_id: string | null;
    [key: string]: unknown;
  };
  active_run_id: string | null;
  open_human_gate: { run_id: string; task_id: string | null } | null;
  open_drawer: { run_id: string; task_id: string } | null;
  [key: string]: unknown;
}

/** Object fields merge, arrays replace; null entries delete lineup map entries. */
export interface GuidedSessionPatch {
  schema_version?: number;
  active_stage?: GuidedStage;
  workspace_path?: string | null;
  brainstorm?: Partial<GuidedSession['brainstorm']>;
  workflow?: {
    mode?: WorkflowMode | null;
    preset?: string | null;
    panel_enabled?: boolean;
    launch_request_id?: string | null;
    lineup?: { roles?: Record<string, string | null>; model_overrides?: Record<string, string | null>; size?: ProjectSize };
    [key: string]: unknown;
  };
  active_run_id?: string | null;
  open_human_gate?: GuidedSession['open_human_gate'];
  open_drawer?: GuidedSession['open_drawer'];
  [key: string]: unknown;
}

export interface L0ModelOption {
  provider: string;
  model: string;
  effort: string;
  spec: string;
  label: string;
}
export interface L0ModelsResult {
  models: L0ModelOption[];
  auto_selected: string | null;
}

export type RunStatus = 'PENDING' | 'PLANNING' | 'RUNNING' | 'PAUSED' | 'WAITING_HUMAN'
  | 'READY_FOR_FINAL_GATE' | 'COMPLETED' | 'FAILED' | 'SUPERSEDED';
export interface RunLineageFields {
  parent_run_id: string | null;
  base_ref: string | null;
  start_sha: string | null;
  result_sha: string | null;
  launch_request_id?: string | null;
}
export type LineageRunListItem = Omit<RunListItem, 'status'> & RunLineageFields & { status: RunStatus | (string & {}) };
export type LineageRunSnapshot = Omit<LiveRunSnapshot, 'run'> & {
  run: (Record<string, unknown> & RunLineageFields & { status?: RunStatus | (string & {}) }) | null;
};

export type GuidedLaunchRunRequest = Omit<LaunchRunRequest, 'role_providers' | 'model_overrides'> & ({
  lineup: WorkflowLineup;
  role_providers?: never;
  model_overrides?: never;
  /** False switches a small run back to the full flow for this run only; absent means on. */
  lean_flow?: boolean;
} | {
  lineup?: never;
  role_providers?: Record<string, string>;
  model_overrides?: Record<string, string>;
  lean_flow?: never;
}) & {
  launch_request_id?: string;
  preset?: string | null;
};
export type StartRunResult =
  | { run_id: string; daemon_pid: number; status: 'STARTED'; reused?: false }
  | { run_id: string; daemon_pid: null; status: string; reused: true };

export type RunTaskTestStatus = 'passed' | 'failed' | 'not_run' | 'not_configured';

export interface RunTaskDetail {
  run_id: string;
  task_id: string;
  milestone_id: string;
  title: string;
  tier: string;
  status: string;
  summary: string;
  attempts: number;
  test_status: RunTaskTestStatus;
  provider: string | null;
  model: string | null;
  elapsed_sec: number;
  cost_usd: number;
  changed_files: string[];
  review_verdict: string | null;
}

export interface ResolveRunTaskRequest {
  taskId: string;
  choice: RunDecision;
  note?: string;
}

export interface ResolveRunTaskResult {
  ok: true;
  run_id: string;
  task_id: string;
  status: string;
}

export type FinalizeAction = 'approve' | 'revise' | 'rollback';

export interface FinalizeRequest {
  action: FinalizeAction;
  /** Required (non-blank) for `revise`. */
  note?: string;
}

export interface FinalizeResult {
  ok: true;
  run_id: string;
  action: FinalizeAction;
  status: string;
  backup_tag: string | null;
  base_branch: string;
  base_head: string | null;
  /** approve */
  merged_commit?: string;
  changed_files?: string[];
  reintegrated?: boolean;
  gates?: GateCommandResult[];
  /** rollback */
  restored_to?: string;
  /** revise */
  revisions_path?: string;
  revision_run_id?: string;
  revision_status?: string;
  daemon_pid?: number;
}

export interface GateCommandResult {
  command: string;
  passed: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_sec: number;
}

/** A recorded `gate_receipt` event: one command a gate suite ran. */
export interface GateReceipt {
  event_id: number;
  scope: 'task' | 'milestone' | 'merge' | 'final';
  target_id: string;
  command: string;
  exit_code: number;
  passed: boolean;
  duration_sec: number;
  output_tail: string;
  created_at: number;
}

export interface HandoffNodeRef {
  kind: 'panel' | 'planner' | 'task' | 'milestone' | 'final_gate';
  id: string | null;
}

export interface HandoffInvocation {
  event_id: number;
  artifact_key: string | null;
  role: string;
  model: string;
  side: 'from' | 'to';
  created_at: number;
  status: string | null;
  duration_sec: number | null;
}

export interface RunHandoff {
  /** `${from}>${to}`, for example "planner>task:T1". */
  id: string;
  from: HandoffNodeRef;
  to: HandoffNodeRef;
  /** Whether recorded events back this handoff. */
  recorded: boolean;
  event_ids: number[];
  at: number | null;
  invocations: HandoffInvocation[];
  /** null when no changed files were recorded. */
  changed_files: string[] | null;
  receipts: GateReceipt[];
  review: { verdict: string; summary: string; reviewer: string; event_id: number } | null;
  takeover: { status: string | null; holder: string | null };
  blocked_reason: string | null;
}

export interface RunHandoffsResponse {
  run_id: string;
  handoffs: RunHandoff[];
  /** Every gate receipt of the run, oldest first; absent from older servers. */
  receipts?: GateReceipt[];
}

export interface ArtifactText {
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface RunArtifactResponse {
  run_id: string;
  artifact_key: string;
  prompt: ArtifactText | null;
  output: ArtifactText | null;
}

export interface EvidenceCriterion {
  index: number;
  text: string;
  state: 'receipt' | 'files_only' | 'not_linked';
  result: 'passed' | 'failed' | null;
  receipts: GateReceipt[];
  files: string[];
}

export interface RunEvidenceResponse {
  run_id: string;
  rfc_available: boolean;
  criteria: EvidenceCriterion[];
  run_level_receipts: GateReceipt[];
  summary: { criteria: number; passed: number; failed: number; files_only: number; not_linked: number; receipts: number };
}

export type RevisionResult = FinalizeResult & {
  action: 'revise'; status: 'SUPERSEDED'; revisions_path: string;
  revision_run_id: string; revision_status: string; daemon_pid: number;
};
export type RollbackMode = 'revert_revision' | 'abandon_all' | 'undo';
export interface RollbackResult {
  ok: true;
  run_id: string;
  mode: RollbackMode;
  status: 'PAUSED';
  restored_to: string;
  base_branch: string;
  base_head: string;
}
export interface StopAndReplanResult {
  ok: true;
  status: 'SUPERSEDED';
  run_id: string;
  failed_tasks: Record<string, unknown>[];
  last_errors: Record<string, string>;
  current_sha: string;
  run_summary: string;
}
export type ApprovalSuccessResult = FinalizeResult & {
  action: 'approve'; status: 'COMPLETED'; merged_commit: string; changed_files: string[];
};
/** Approval keeps the server's 409 conflict and gate details distinct from success. */
export type ApproveAndMergeResult =
  | { kind: 'merged'; result: ApprovalSuccessResult & { reintegrated?: false } }
  | { kind: 'reintegrated'; result: ApprovalSuccessResult & { reintegrated: true; gates: GateCommandResult[] } }
  | { kind: 'conflict'; error: ApiError; conflicts: string[]; base_head: string }
  | { kind: 'gate_failed'; error: ApiError; gates: GateCommandResult[] };

const DEMO_DOCTOR_LATENCY_MS = 5000;
export const DEFAULT_START_RUN_TIMEOUT_MS = 15_000;
const CREDENTIAL_KEYS = ['GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY'] as const;

// Representative rows from the server's built-in catalog.
const DEMO_PRICING: PricingStatusResponse = {
  models: [
    { model: 'claude-sonnet-4-6', input_per_1m: 3, output_per_1m: 15, cached_input_per_1m: 0.3, source: 'builtin' },
    { model: 'deepseek-flash', input_per_1m: 0.3, output_per_1m: 1.2, cached_input_per_1m: 0.006, source: 'builtin' },
    { model: 'gpt-4o', input_per_1m: 2.5, output_per_1m: 10, cached_input_per_1m: 1.25, source: 'builtin' },
  ],
  cache: {
    path: '',
    fetched_at: null,
    age_sec: null,
    stale: true,
    refresh_interval_hours: 24,
    auto_sync: false,
    source_url: '',
  },
  custom_path: '',
};

function maskCredential(value: string): string {
  const characters = Array.from(value);
  const masked = characters.length <= 8
    ? '••••'
    : `${characters.slice(0, 4).join('')}••••${characters.slice(-4).join('')}`;
  return masked.includes(value) ? '****' : masked;
}

function toRoleConfig(role: WireRoleConfig): RoleConfig {
  return {
    ...role,
    fallback: role.fallback.map((target) =>
      typeof target === 'string' ? target : `${target.provider}:${target.model}`,
    ),
  };
}

function toPricingStatus({ cache, ...catalog }: WirePricingStatusResponse): PricingStatusResponse {
  const fetchedAt = cache.fetched_at;
  // The M2 API reports Unix seconds. Studio consumes an ISO timestamp.
  return {
    ...catalog,
    cache: { ...cache, fetched_at: typeof fetchedAt === 'number' ? new Date(fetchedAt * 1000).toJSON() : fetchedAt },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class BatonApiClient {
  mode: ApiMode = 'demo';
  health: Record<string, unknown> | null = null;
  private readonly baseUrl: string;
  private demoBudgetProfile: BudgetProfile = 'balanced';
  private readonly demoCredentials = new Map<string, string>();
  private demoCustomPricing = new Map<string, PricingModelEntry>();

  constructor(
    baseUrl = '',
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async init(): Promise<ApiMode> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      const deadline = new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, 1500);
      });
      this.health = await Promise.race([this.probeHealth(controller.signal), deadline]);
    } catch {
      this.health = null;
    } finally {
      clearTimeout(timeout);
    }
    this.mode = this.health === null ? 'demo' : 'local';
    return this.mode;
  }

  async listPresets(): Promise<PresetItem[]> {
    if (this.mode === 'demo') {
      return PRESET_REGISTRY.map((graph) => {
        const requiredProviders = [...(graph.required_providers ?? [])];
        const missingProviders = requiredProviders.filter((provider) => !demoProviderHealth(provider).ok);
        return {
          ...presetToItem(graph),
          category: graph.category ?? 'general',
          required_providers: requiredProviders,
          cost_tier: graph.cost_tier ?? 'medium',
          inspired_by: graph.inspired_by ?? null,
          host_ready: missingProviders.length === 0,
          missing_providers: missingProviders,
        };
      });
    }
    const { presets } = await this.requestJson<{ presets: PresetItem[] }>('/api/presets');
    return presets;
  }

  async getPreset(id: string): Promise<WorkflowGraph> {
    if (this.mode === 'demo') {
      const preset = findPreset(id);
      if (!preset) throw new ApiError(404, `Unknown preset ID '${id}'`);
      return preset;
    }
    const { graph } = await this.requestJson<{ graph: WorkflowGraph }>(`/api/presets/${encodeURIComponent(id)}`);
    return graph;
  }

  async validate(graph: WorkflowGraph): Promise<GraphValidationResult> {
    if (this.mode === 'demo') return validateGraph(graph);
    return this.requestJson('/api/graph/validate', { method: 'POST', body: { graph } });
  }

  async simulate(graph: WorkflowGraph, scenario: Scenario): Promise<SimulationResult> {
    if (this.mode === 'demo') return simulateGraph(graph, scenario);
    return this.requestJson('/api/graph/simulate', { method: 'POST', body: { graph, scenario } });
  }

  async getRoles(): Promise<RolesConfigResponse | null> {
    return this.mode === 'demo' ? null : this.getRolesConfig();
  }

  async getRolesConfig(): Promise<RolesConfigResponse> {
    if (this.mode === 'demo') {
      return { ...structuredClone(DEMO_ROLES_CONFIG), budget_profile: this.demoBudgetProfile };
    }
    const config = await this.requestJson<WireRolesConfigResponse>('/api/config/roles');
    return {
      ...config,
      roles: Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, toRoleConfig(role)])),
    };
  }

  async setBudgetProfile(profile: BudgetProfile): Promise<BudgetConfigResponse> {
    if (this.mode === 'local') {
      return this.requestJson('/api/config/budget', { method: 'PUT', body: { budget_profile: profile } });
    }
    this.demoBudgetProfile = profile;
    return { budget_profile: profile, model_catalog: structuredClone(DEMO_ROLES_CONFIG.model_catalog) };
  }

  async getPricing(): Promise<PricingStatusResponse> {
    if (this.mode === 'local') {
      return toPricingStatus(await this.requestJson<WirePricingStatusResponse>('/api/pricing'));
    }

    const models = [
      ...DEMO_PRICING.models.filter(({ model }) => !this.demoCustomPricing.has(model)),
      ...this.demoCustomPricing.values(),
    ].sort((left, right) => left.model.localeCompare(right.model));
    return structuredClone({ ...DEMO_PRICING, models });
  }

  async syncPricing(force = false): Promise<PricingSyncResponse> {
    if (this.mode === 'local') {
      const result = await this.requestJson<WirePricingSyncResponse>('/api/pricing/sync', {
        method: 'POST', body: { force },
      });
      return { ...result, catalog: toPricingStatus(result.catalog) };
    }

    const catalog = await this.getPricing();
    return { ok: true, fetched: false, skipped_fresh: true, model_count: catalog.models.length, error: null, catalog };
  }

  async saveCustomPricing(updates: CustomPricingUpdate): Promise<PricingStatusResponse> {
    if (this.mode === 'local') {
      const catalog = await this.requestJson<WirePricingStatusResponse>('/api/pricing/custom', {
        method: 'PUT', body: { updates },
      });
      return toPricingStatus(catalog);
    }

    const custom = new Map(this.demoCustomPricing);
    for (const [name, rates] of Object.entries(updates)) {
      const model = name.trim();
      if (!model) throw new ApiError(400, 'Custom pricing requires a non-empty model name.');
      if (rates === null) {
        custom.delete(model);
        continue;
      }

      const { input_per_1m, output_per_1m, cached_input_per_1m } = rates;
      if ([input_per_1m, output_per_1m, cached_input_per_1m].some((rate) => !Number.isFinite(rate) || rate < 0)) {
        throw new ApiError(400, `Invalid custom rates for '${model}'. Expected finite non-negative token rates.`);
      }
      custom.set(model, { model, input_per_1m, output_per_1m, cached_input_per_1m, source: 'custom' });
    }
    this.demoCustomPricing = custom;
    return this.getPricing();
  }

  async doctorRole(payload: DoctorRoleRequest): Promise<DoctorRoleResult> {
    if (this.mode === 'local') {
      return this.requestJson('/api/doctor/role', { method: 'POST', body: payload });
    }

    const roleName = payload.role?.trim() ?? '';
    const roleProvider = Object.hasOwn(DEMO_ROLES_CONFIG.roles, roleName)
      ? DEMO_ROLES_CONFIG.roles[roleName].provider
      : '';
    const prefix = payload.model?.trim().match(/^([^:]+):/)?.[1] ?? '';
    const modelProvider = roleProvider && Object.hasOwn(DEMO_ROLES_CONFIG.providers, prefix) ? prefix : '';
    const provider = payload.provider?.trim() || modelProvider || roleProvider;
    await new Promise<void>((resolve) => setTimeout(resolve, DEMO_DOCTOR_LATENCY_MS));
    return { ...demoProviderHealth(provider), latency_ms: DEMO_DOCTOR_LATENCY_MS };
  }

  async listCredentials(): Promise<CredentialStatus[]> {
    if (this.mode === 'local') return this.requestJson('/api/credentials');
    return CREDENTIAL_KEYS.map((key) => {
      const masked = this.demoCredentials.get(key);
      return {
        provider_key: key,
        configured: masked !== undefined,
        // Match the server's saved-credential status for the UI preview.
        source: masked === undefined ? 'none' : 'local_file',
        masked: masked ?? '',
      };
    });
  }

  async saveCredentials(updates: Record<string, string>): Promise<CredentialStatus[]> {
    if (this.mode === 'local') {
      return this.requestJson('/api/credentials', { method: 'POST', body: { updates } });
    }
    for (const key of CREDENTIAL_KEYS) {
      const value = updates[key];
      if (typeof value !== 'string' || value.includes('\0')) continue;
      if (value) this.demoCredentials.set(key, maskCredential(value));
      else this.demoCredentials.delete(key);
    }
    return this.listCredentials();
  }

  async checkRfc(rfcMarkdown: string): Promise<RfcReadinessResult> {
    if (this.mode === 'demo') return checkRfcReadiness(rfcMarkdown);
    return this.requestJson('/api/rfc/check', { method: 'POST', body: { rfc_markdown: rfcMarkdown } });
  }

  async updateRole(role: string, payload: { provider?: string; model: string }): Promise<RoleConfig> {
    const { role: updated } = await this.requestJson<{ role: WireRoleConfig }>(
      `/api/config/roles/${encodeURIComponent(role)}`,
      { method: 'PUT', body: payload },
    );
    return toRoleConfig(updated);
  }

  async listRuns(): Promise<RunListItem[]> {
    if (this.mode === 'demo') return [];
    const { runs } = await this.requestJson<{ runs: RunListItem[] }>('/api/runs');
    return runs;
  }

  async getLatestRun(): Promise<LiveRunSnapshot> {
    if (this.mode === 'demo') return { run: null, milestones: [], tasks: [], events: [], quotas: [], telemetry: null };
    return this.requestJson('/api/runs/latest');
  }

  getRun(id: string): Promise<LiveRunSnapshot> {
    return this.requestJson(`/api/runs/${encodeURIComponent(id)}`);
  }

  listLineageRuns(): Promise<LineageRunListItem[]> {
    return this.listRuns() as Promise<LineageRunListItem[]>;
  }

  getLatestLineageRun(): Promise<LineageRunSnapshot> {
    return this.getLatestRun() as Promise<LineageRunSnapshot>;
  }

  getLineageRun(id: string): Promise<LineageRunSnapshot> {
    return this.getRun(id) as Promise<LineageRunSnapshot>;
  }

  async getRunReport(id: string, lang?: 'en' | 'zh'): Promise<string> {
    const query = lang ? `?lang=${encodeURIComponent(lang)}` : '';
    const { battle_report_markdown } = await this.requestJson<{ battle_report_markdown: string }>(
      `/api/runs/${encodeURIComponent(id)}/report${query}`,
    );
    return battle_report_markdown;
  }

  async exportRunCase(
    runId: string,
    options: { title?: string; includeReviews?: boolean; anonymize?: boolean } = {},
  ): Promise<BatonCaseBundle> {
    let raw: unknown;
    if (this.mode === 'demo') {
      const bundle = buildOfficialStage1Case('en');
      raw = { ...bundle, title: options.title ?? bundle.title };
    } else {
      const query = new URLSearchParams();
      if (options.title !== undefined) query.set('title', options.title);
      query.set('include_reviews', options.includeReviews === false ? '0' : '1');
      query.set('anonymize', options.anonymize ? '1' : '0');
      raw = await this.requestJson<unknown>(`/api/runs/${encodeURIComponent(runId)}/case-export?${query}`);
    }

    const result = parseAndValidateCaseBundle(raw);
    if (!result.ok) throw new ApiError(502, result.errors.join(' '));
    return result.bundle;
  }

  /** Every real run starts with a launch request ID, so a retry after an uncertain result finds the same run. */
  async startRun(
    payload: GuidedLaunchRunRequest & { launch_request_id: string },
    timeoutMs = DEFAULT_START_RUN_TIMEOUT_MS,
  ): Promise<StartRunResult> {
    if (this.mode === 'demo') throw new ApiError(0, 'Not available in standalone demo');
    const controller = new AbortController();
    let timedOut = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
    try {
      return await this.requestJson('/api/runs/start', { method: 'POST', body: payload }, controller.signal);
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        throw new ApiError(408, 'Request timed out');
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  startGuidedRun(payload: GuidedLaunchRunRequest & { launch_request_id: string }, timeoutMs?: number): Promise<StartRunResult> {
    return this.startRun(payload, timeoutMs);
  }

  controlRun(id: string, action: 'pause' | 'resume'): Promise<{
    run_id: string;
    status: string;
    daemon_pid?: number;
  }> {
    return this.requestJson(`/api/runs/${encodeURIComponent(id)}/control`, { method: 'POST', body: { action } });
  }

  resolveRun(id: string, decision: RunDecision, note?: string): Promise<{
    run_id: string;
    decision: RunDecision;
    daemon_pid: number | null;
  }> {
    return this.requestJson(`/api/runs/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: { decision, note } });
  }

  getCliRegistry(): Promise<CliRegistry> {
    return this.requestJson('/api/cli-registry');
  }

  scanCliRegistry(repoPath?: string): Promise<CliRegistryScanResponse> {
    return this.requestJson('/api/cli-registry/scan', {
      method: 'POST', body: repoPath === undefined ? {} : { repo_path: repoPath },
    });
  }

  installCli({ cliId }: CliInstallRequest): Promise<CliInstallResult> {
    // Only the driver id travels; the server runs its own allowlisted registry recipe.
    return this.requestJson('/api/cli-registry/install', { method: 'POST', body: { id: cliId, confirmed: true } });
  }

  loginCli(cliId: string): Promise<CliLoginResult> {
    return this.requestJson('/api/cli-registry/login', { method: 'POST', body: { id: cliId } });
  }

  getWorkspaceInfo(): Promise<WorkspaceInfo> {
    return this.requestJson('/api/workspace/info');
  }

  selectWorkspace(path: string): Promise<WorkspaceInfo> {
    return this.requestJson('/api/workspace/select', { method: 'POST', body: { path } });
  }

  browseWorkspace(): Promise<BrowseWorkspaceResult> {
    return this.requestJson('/api/workspace/browse', { method: 'POST', body: {} });
  }

  openWorkspacePath(options: { path?: string; reveal?: boolean } = {}): Promise<{ ok: boolean; path: string; reveal: boolean }> {
    if (this.mode === 'demo') {
      return Promise.resolve({ ok: true, path: options.path ?? '.', reveal: Boolean(options.reveal) });
    }
    return this.requestJson('/api/workspace/open', { method: 'POST', body: options });
  }

  initGitWorkspace(): Promise<InitGitResult> {
    return this.requestJson('/api/workspace/init-git', { method: 'POST', body: {} });
  }

  getLineupProfiles(): Promise<LineupProfilesResponse> {
    if (this.mode === 'demo') return Promise.resolve({ profiles: [], last_used: null });
    return this.requestJson('/api/lineup-profiles');
  }

  saveLineupProfile(payload: {
    id?: string;
    name: string;
    roles: Record<string, string>;
    model_overrides?: Record<string, string>;
  }): Promise<SaveLineupProfileResponse> {
    if (this.mode === 'demo') {
      const profile: SavedLineupProfile = {
        id: payload.id ?? 'demo-profile',
        name: payload.name,
        roles: payload.roles,
        model_overrides: payload.model_overrides ?? {},
        updated_at: Date.now() / 1000,
      };
      return Promise.resolve({ profile, profiles: [profile], last_used: null });
    }
    return this.requestJson('/api/lineup-profiles', { method: 'POST', body: payload });
  }

  deleteLineupProfile(profileId: string): Promise<LineupProfilesResponse> {
    if (this.mode === 'demo') return Promise.resolve({ profiles: [], last_used: null });
    return this.requestJson(`/api/lineup-profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
  }

  saveLastUsedLineup(payload: {
    roles: Record<string, string>;
    model_overrides?: Record<string, string>;
    profile_id?: string | null;
    profile_name?: string | null;
  }): Promise<LineupProfilesResponse> {
    if (this.mode === 'demo') return Promise.resolve({ profiles: [], last_used: null });
    return this.requestJson('/api/lineup-profiles/last-used', { method: 'POST', body: payload });
  }

  brainstormChat(payload: BrainstormChatRequest): Promise<BrainstormTurnResult> {
    return this.requestJson('/api/brainstorm/chat', { method: 'POST', body: payload });
  }

  async getGuidedSession(): Promise<GuidedSession> {
    const { session } = await this.requestJson<{ session: GuidedSession }>('/api/guided/session');
    return session;
  }

  async saveGuidedSession(session: GuidedSessionPatch): Promise<GuidedSession> {
    const response = await this.requestJson<{ session: GuidedSession }>('/api/guided/session', {
      method: 'PUT', body: { session },
    });
    return response.session;
  }

  async resetGuidedSession(): Promise<GuidedSession> {
    const { session } = await this.requestJson<{ session: GuidedSession }>('/api/guided/session/reset', {
      method: 'POST', body: {},
    });
    return session;
  }

  getL0Models(): Promise<L0ModelsResult> {
    return this.requestJson('/api/guided/l0-models');
  }

  recommendBlueprint(rfcMarkdown: string): Promise<GuidedRecommendResult> {
    return this.requestJson('/api/guided/recommend', { method: 'POST', body: { rfc_markdown: rfcMarkdown } });
  }

  async getDismissedAttention(): Promise<string[]> {
    if (this.mode === 'demo') return [];
    const { fingerprints } = await this.requestJson<{ fingerprints: string[] }>('/api/attention/dismissed');
    return fingerprints;
  }

  async dismissAttention(fingerprint: string): Promise<string[]> {
    if (this.mode === 'demo') return [fingerprint];
    const { fingerprints } = await this.requestJson<{ fingerprints: string[] }>('/api/attention/dismiss', {
      method: 'POST',
      body: { fingerprint },
    });
    return fingerprints;
  }

  getModelCatalog(): Promise<ModelCatalogResponse> {
    return this.requestJson('/api/models/catalog');
  }

  syncModelCatalog(force = false): Promise<ModelCatalogSyncResponse> {
    return this.requestJson('/api/models/catalog/sync', {
      method: 'POST',
      body: { force },
    });
  }

  getRunTaskDetail(runId: string, taskId: string, locale?: 'en' | 'zh'): Promise<RunTaskDetail> {
    const query = locale === 'zh' ? '?lang=zh' : '';
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}${query}`);
  }

  getRunHandoffs(runId: string): Promise<RunHandoffsResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/handoffs`);
  }

  /** The server answers 404 for a key this run did not record. */
  getRunArtifact(runId: string, artifactKey: string): Promise<RunArtifactResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactKey)}`);
  }

  getRunEvidence(runId: string): Promise<RunEvidenceResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/evidence`);
  }

  resolveRunTask(runId: string, { taskId, choice, note = '' }: ResolveRunTaskRequest): Promise<ResolveRunTaskResult> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/resolve`, {
      method: 'POST', body: { task_id: taskId, choice, note },
    });
  }

  finalizeRun(runId: string, { action, note = '' }: FinalizeRequest): Promise<FinalizeResult> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/finalize`, {
      method: 'POST', body: { action, note },
    });
  }

  requestChanges(runId: string, note: string): Promise<RevisionResult> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/request-changes`, {
      method: 'POST', body: { note },
    });
  }

  async approveAndMerge(runId: string, note = ''): Promise<ApproveAndMergeResult> {
    try {
      const result = await this.finalizeRun(runId, { action: 'approve', note }) as ApprovalSuccessResult;
      return result.reintegrated
        ? { kind: 'reintegrated', result: result as ApprovalSuccessResult & { reintegrated: true; gates: GateCommandResult[] } }
        : { kind: 'merged', result: result as ApprovalSuccessResult & { reintegrated?: false } };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const data = error.data;
        if (error.code === 'INTEGRATION_CONFLICT' && Array.isArray(data?.conflicts)
          && data.conflicts.every((path: unknown) => typeof path === 'string') && typeof data.base_head === 'string') {
          return { kind: 'conflict', error, conflicts: data.conflicts as string[], base_head: data.base_head };
        }
        if (error.code === 'GATE_FAILED' && Array.isArray(data?.gates)) {
          return { kind: 'gate_failed', error, gates: data.gates as GateCommandResult[] };
        }
      }
      throw error;
    }
  }

  rollbackRun(runId: string, mode: RollbackMode, note = ''): Promise<RollbackResult> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/rollback`, {
      method: 'POST', body: { mode, note },
    });
  }

  stopAndReplan(runId: string, timeoutSec?: number): Promise<StopAndReplanResult> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/stop-and-replan`, {
      method: 'POST', body: timeoutSec === undefined ? {} : { timeout_sec: timeoutSec },
    });
  }

  streamUrl(): string {
    return `${this.baseUrl}/api/runs/stream`;
  }

  private async probeHealth(signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/health`, { method: 'GET', signal });
    if (response.status !== 200) return null;
    const health: unknown = await response.json();
    return isRecord(health) && health.status === 'ok' ? health : null;
  }

  private async requestJson<T>(
    path: string,
    write?: { method: 'POST' | 'PUT' | 'DELETE'; body?: object },
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.mode === 'demo') throw new ApiError(0, 'Not available in standalone demo');

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, write ? {
      method: write.method,
      ...(write.body !== undefined ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(write.body),
      } : {}),
      ...(signal ? { signal } : {}),
    } : { method: 'GET', ...(signal ? { signal } : {}) });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message = isRecord(body) && typeof body.error === 'string'
        ? body.error
        : response.statusText || `HTTP ${response.status}`;
      throw new ApiError(response.status, message, isRecord(body) ? body : undefined);
    }
    return response.json() as Promise<T>;
  }
}
