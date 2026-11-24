import { expect, expectTypeOf, test } from 'vitest';
import { BatonApiClient } from '../api/client';
import { claude_only_3tier, findPreset } from '../data/presets';
import { flagship_4tier } from '../data/presets/flagship_4tier';
import type {
  AttentionCategory,
  AttentionSeverity,
  BillingTelemetry,
  BudgetProfile,
  CostTier,
  CredentialStatus,
  CustomPricingUpdate,
  DoctorRoleResult,
  LaunchRunMode,
  LaunchRunRequest,
  LiveRunSnapshot,
  ModelCapability,
  ModelTelemetry,
  NodeType,
  PresetCategory,
  PresetItem,
  PricingCacheStatus,
  PricingModelEntry,
  PricingStatusResponse,
  PricingSyncResponse,
  ProviderHealthSummary,
  RfcReadinessResult,
  RunAttentionState,
  RunTelemetry,
  StageTelemetry,
  TaskTiming,
  TierKey,
  WorkflowGraph,
} from './graph';
import { tierForNodeType } from './graph';

test('the flagship nodes use the tiers of their configured roles', () => {
  const tiers = flagship_4tier.nodes.map(({ id, type, role }) => [id, tierForNodeType(type, role)]);
  expect(Object.fromEntries(tiers)).toEqual({
    l0_brainstorm: 'L0',
    l1_plan: 'L1',
    router_tier: 'ROUTER',
    l2_specialist: 'L2',
    l3_bulk: 'L3',
    gate_unit: 'GATE',
    l2_review: 'L2',
    git_merge: 'MERGE',
    l1_milestone_review: 'L1',
    l0_final_gate: 'L0',
  });
});

test.each<[NodeType, TierKey]>([
  ['planner_node', 'L1'],
  ['router_node', 'ROUTER'],
  ['worker_node', 'L2'],
  ['gate_node', 'GATE'],
  ['reviewer_node', 'L1'],
  ['merge_node', 'MERGE'],
  ['human_gate_node', 'HUMAN'],
])('%s uses its type tier when the role is absent or unrecognized', (type, tier) => {
  expect(tierForNodeType(type)).toBe(tier);
  expect(tierForNodeType(type, 'custom_role')).toBe(tier);
});

test('workflow graphs allow optional preset metadata with the catalog values', () => {
  expectTypeOf<PresetCategory>().toEqualTypeOf<'same_family' | 'bulk_batch' | 'small_project' | 'audit' | 'panel' | 'general'>();
  expectTypeOf<CostTier>().toEqualTypeOf<'low' | 'medium' | 'high'>();
  expectTypeOf<Pick<WorkflowGraph, 'category' | 'required_providers' | 'cost_tier' | 'inspired_by'>>()
    .toEqualTypeOf<{
      category?: PresetCategory;
      required_providers?: string[];
      cost_tier?: CostTier;
      inspired_by?: string | null;
    }>();
});

test('launch requests accept the panel run mode', () => {
  expectTypeOf<LaunchRunMode>().toEqualTypeOf<'overnight' | 'interactive' | 'panel'>();
  expectTypeOf<LaunchRunRequest>().toEqualTypeOf<{
    rfc_path?: string;
    rfc_markdown?: string;
    mode?: LaunchRunMode;
    model_overrides?: Record<string, string>;
    role_providers?: Record<string, string>;
  }>();
  expectTypeOf<Parameters<BatonApiClient['startRun']>[0]>().toEqualTypeOf<LaunchRunRequest>();
});

test('Stage 3 API types match local server payloads', () => {
  expectTypeOf<BudgetProfile>().toEqualTypeOf<'eco' | 'balanced' | 'max_quality'>();
  expectTypeOf<ModelCapability>().toEqualTypeOf<{
    provider: string;
    model: string;
    efforts: string[];
    cost_tier: 'eco' | 'standard' | 'flagship';
    ready: boolean;
    detail: string;
  }>();
  expectTypeOf<ProviderHealthSummary>().toEqualTypeOf<{
    provider: string;
    ok: boolean;
    detail: string;
    latency_ms?: number;
    install_hint?: string;
  }>();
  expectTypeOf<DoctorRoleResult>().toMatchTypeOf<Required<ProviderHealthSummary>>();
  expectTypeOf<CredentialStatus>().toEqualTypeOf<{
    provider_key: string;
    configured: boolean;
    source: 'env' | 'local_file' | 'none';
    masked: string;
  }>();
  expectTypeOf<RfcReadinessResult>().toEqualTypeOf<{
    score: number;
    safe_for_overnight: boolean;
    missing_sections: string[];
    warnings: string[];
    detected_commands: string[];
  }>();
});

test('preset summaries support host readiness alongside legacy demo summaries', () => {
  expectTypeOf<Pick<PresetItem, 'host_ready' | 'missing_providers'>>().toEqualTypeOf<{
    host_ready?: boolean;
    missing_providers?: string[];
  }>();
});

test('Studio pricing types expose catalog, cache, sync, and override fields', () => {
  expectTypeOf<PricingModelEntry>().toEqualTypeOf<{
    model: string;
    input_per_1m: number;
    output_per_1m: number;
    cached_input_per_1m: number;
    source: 'custom' | 'official_cache' | 'builtin';
  }>();
  expectTypeOf<PricingCacheStatus>().toEqualTypeOf<{
    path: string;
    fetched_at: string | null;
    age_sec: number | null;
    stale: boolean;
    refresh_interval_hours: number;
    auto_sync: boolean;
    source_url: string;
  }>();
  expectTypeOf<PricingStatusResponse>().toEqualTypeOf<{
    models: PricingModelEntry[];
    cache: PricingCacheStatus;
    custom_path: string;
  }>();
  expectTypeOf<PricingSyncResponse>().toEqualTypeOf<{
    ok: boolean;
    fetched: boolean;
    skipped_fresh: boolean;
    model_count: number;
    error: string | null;
    catalog: PricingStatusResponse;
  }>();
  expectTypeOf<CustomPricingUpdate>().toEqualTypeOf<Record<string, {
    input_per_1m: number;
    output_per_1m: number;
    cached_input_per_1m: number;
  } | null>>();
});

test('run telemetry carries exact billing, per-model usage, and merge conflict counts', () => {
  const telemetry: RunTelemetry = {
    elapsed_sec: 20,
    stages: [],
    models: [{
      actor: 'tactical_planner:fable@high',
      role: 'tactical_planner',
      provider: 'claude_sub',
      display_provider: 'Claude',
      model: 'fable@high',
      calls: 1,
      duration_sec: 12.5,
      estimated: false,
      avg_sec: 12.5,
      share_pct: 100,
      prompt_tokens: 1200,
      completion_tokens: 300,
      cost_usd: 0.0142,
    }],
    billing: {
      total_prompt_tokens: 1200,
      total_completion_tokens: 300,
      total_cached_tokens: 200,
      total_tokens: 1500,
      total_cost_usd: 0.0142,
      has_exact_billing: true,
    },
    conflicts: {
      conflicts_detected: 1,
      conflicts_auto_resolved: 1,
      conflicts_failed: 0,
    },
  };

  expect(telemetry.billing?.total_tokens).toBe(1500);
  expect(telemetry.models[0].cost_usd).toBe(telemetry.billing?.total_cost_usd);
  expect(telemetry.conflicts?.conflicts_auto_resolved).toBe(1);
  expectTypeOf<BillingTelemetry['total_cost_usd']>().toEqualTypeOf<number | null>();
  expectTypeOf<Pick<ModelTelemetry, 'prompt_tokens' | 'completion_tokens' | 'cost_usd'>>().toEqualTypeOf<{
    prompt_tokens?: number;
    completion_tokens?: number;
    cost_usd?: number | null;
  }>();
  expectTypeOf<Pick<RunTelemetry, 'billing' | 'conflicts'>>().toEqualTypeOf<{
    billing?: BillingTelemetry | null;
    conflicts?: {
      conflicts_detected: number;
      conflicts_auto_resolved: number;
      conflicts_failed: number;
    } | null;
  }>();
});

test('run snapshots preserve the optional live timing fields across JSON parsing', async () => {
  const telemetry = {
    elapsed_sec: 20,
    server_now: 120.125,
    stages: [{
      id: 'M1',
      kind: 'milestone',
      title: 'Core Backend',
      status: 'RUNNING',
      wall_sec: 10,
      task_sum_sec: 4,
      passed_tasks: 1,
      total_tasks: 2,
      started_at: 110.125,
      is_active: true,
    }],
    models: [{
      actor: 'critical_executor:gpt',
      role: 'critical_executor',
      provider: 'codex_sub',
      display_provider: 'Codex CLI',
      model: 'gpt',
      calls: 1,
      duration_sec: 5,
      estimated: true,
      avg_sec: 5,
      share_pct: 100,
      active_started_at: 115.125,
    }],
    task_timings: {
      'M1-T1': { duration_sec: 4, started_at: null, is_active: false },
      'M1-T2': { duration_sec: 5, started_at: 115.125, is_active: true },
    },
  } satisfies RunTelemetry;
  const fixture = {
    run: { id: 'run-1', status: 'RUNNING' },
    milestones: [], tasks: [], events: [], quotas: [],
    telemetry,
  } satisfies LiveRunSnapshot;
  const client = new BatonApiClient('', async () => Response.json(fixture));
  client.mode = 'local';

  const snapshot = await client.getRun('run-1');

  expect(snapshot.telemetry).toEqual(telemetry);
  expectTypeOf<Pick<StageTelemetry, 'started_at' | 'is_active'>>().toEqualTypeOf<{
    started_at?: number | null;
    is_active?: boolean;
  }>();
  expectTypeOf<Pick<ModelTelemetry, 'active_started_at'>>().toEqualTypeOf<{
    active_started_at?: number | null;
  }>();
  expectTypeOf<Pick<RunTelemetry, 'server_now' | 'task_timings'>>().toEqualTypeOf<{
    server_now?: number;
    task_timings?: Record<string, TaskTiming>;
  }>();
});

test('run telemetry may omit attention or explicitly clear it', () => {
  expectTypeOf<Pick<RunTelemetry, 'attention'>>().toEqualTypeOf<{
    attention?: RunAttentionState | null;
  }>();
  const telemetry = { elapsed_sec: 20, stages: [], models: [], attention: null } satisfies RunTelemetry;
  expect(telemetry.attention).toBeNull();
});

test('run telemetry accepts a complete attention state from a live snapshot', async () => {
  expectTypeOf<AttentionSeverity>().toEqualTypeOf<'warning' | 'error' | 'info'>();
  expectTypeOf<AttentionCategory>()
    .toEqualTypeOf<'waiting_human' | 'ready_for_final_gate' | 'failed' | 'paused' | 'long_cooldown'>();
  expectTypeOf<RunAttentionState['created_at']>().toEqualTypeOf<string | number | null>();
  const attention = {
    category: 'waiting_human',
    severity: 'warning',
    title: 'Human decision required',
    message: 'Review the unresolved task.',
    action_hint: 'Review and resolve the blocker in Studio.',
    milestone_id: 'M1',
    task_id: 'M1-T1',
    created_at: 120.125,
  } satisfies RunAttentionState;
  const fixture = {
    run: { id: 'run-1', status: 'WAITING_HUMAN' },
    milestones: [], tasks: [], events: [], quotas: [],
    telemetry: { elapsed_sec: 20, stages: [], models: [], attention },
  } satisfies LiveRunSnapshot;
  const client = new BatonApiClient('', async () => Response.json(fixture));
  client.mode = 'local';

  const snapshot = await client.getRun('run-1');

  expect(snapshot.telemetry?.attention).toEqual(attention);
});

test('the Claude Golden preset resolves by id', () => {
  expect(findPreset('claude_only_3tier')).toBe(claude_only_3tier);
});
