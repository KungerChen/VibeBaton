import { expect, expectTypeOf, test } from 'vitest';
import { BatonApiClient } from '../api/client';
import { claude_only_3tier, findPreset } from '../data/presets';
import { flagship_4tier } from '../data/presets/flagship_4tier';
import type {
  BillingTelemetry,
  BudgetProfile,
  CostTier,
  CredentialStatus,
  DoctorRoleResult,
  LiveRunSnapshot,
  ModelCapability,
  ModelTelemetry,
  NodeType,
  PresetCategory,
  PresetItem,
  ProviderHealthSummary,
  RfcReadinessResult,
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
  expectTypeOf<PresetCategory>().toEqualTypeOf<'same_family' | 'bulk_batch' | 'small_project' | 'audit' | 'general'>();
  expectTypeOf<CostTier>().toEqualTypeOf<'low' | 'medium' | 'high'>();
  expectTypeOf<Pick<WorkflowGraph, 'category' | 'required_providers' | 'cost_tier' | 'inspired_by'>>()
    .toEqualTypeOf<{
      category?: PresetCategory;
      required_providers?: string[];
      cost_tier?: CostTier;
      inspired_by?: string | null;
    }>();
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

test('the Claude Golden preset resolves by id', () => {
  expect(findPreset('claude_only_3tier')).toBe(claude_only_3tier);
});
