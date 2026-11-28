import { expect, expectTypeOf, test, vi } from 'vitest';
import { presetToItem, specialist_panel, starter_2tier } from '../data/presets';
import goldenCase from '../engine/__fixtures__/goldenCase.json';
import { filterPresets } from '../components/recipePlaza';
import { buildOfficialStage1Case } from '../engine/caseReplay';
import type {
  BudgetConfigResponse,
  CredentialStatus,
  CustomPricingUpdate,
  DoctorRoleResult,
  GraphValidationResult,
  LiveRunSnapshot,
  PresetItem,
  PricingModelEntry,
  PricingStatusResponse,
  PricingSyncResponse,
  RfcReadinessResult,
  RunListItem,
  SimulationResult,
} from '../types/graph';
import {
  ApiError,
  BatonApiClient,
  type BrainstormTurnResult,
  type CliDriver,
  type CliInstallRequest,
  type CliInstallResult,
  type CliLoginResult,
  type CliRegistry,
  type CliRegistryScanResponse,
  type FinalizeResult,
  type GateReceipt,
  type GuidedSession,
  type WorkflowRecommendation,
  type InitGitResult,
  type ResolveRunTaskResult,
  type RunArtifactResponse,
  type RunEvidenceResponse,
  type RunHandoffsResponse,
  type RunTaskDetail,
  type WorkspaceInfo,
} from './client';

const health = { status: 'ok', version: 'test' };

function healthyFetch() {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(health));
}

function jsonRequest(method: 'POST' | 'PUT', body: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Golden example of probing a server and using its preset catalog.
test('probes the configured local server and loads its presets', async () => {
  const baseUrl = 'http://127.0.0.1:7860';
  const preset: PresetItem = { ...presetToItem(starter_2tier), host_ready: true, missing_providers: [] };
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json({ presets: [preset] }));
  const client = new BatonApiClient(`${baseUrl}/`, fetchImpl);

  expect(client.mode).toBe('demo');
  expect(client.health).toBeNull();
  await expect(client.init()).resolves.toBe('local');
  expect(client.mode).toBe('local');
  expect(client.health).toEqual(health);
  await expect(client.listPresets()).resolves.toEqual([preset]);
  expect(client.streamUrl()).toBe(`${baseUrl}/api/runs/stream`);

  expect(fetchImpl.mock.calls).toEqual([
    [`${baseUrl}/api/health`, { method: 'GET', signal: expect.any(AbortSignal) }],
    [`${baseUrl}/api/presets`, { method: 'GET' }],
  ]);
});

test('M3 session, model and brainstorm routes preserve their typed wire contracts', async () => {
  const session: GuidedSession = {
    schema_version: 1, active_stage: 'blueprint', workspace_path: '/repo',
    brainstorm: { messages: [], checklist: [], latest_rfc_draft: '# draft', selected_l0_model: null, has_online_draft: true },
    workflow: { mode: null, lineup: { roles: {}, model_overrides: {} }, preset: null, panel_enabled: false, launch_request_id: null },
    active_run_id: null, open_human_gate: null, open_drawer: null,
  };
  const recommendation: WorkflowRecommendation = {
    mode: 'overnight', preset: 'solo_coder_3tier', lineup: { roles: {}, model_overrides: {} },
    size: 'medium', reason_code: 'medium_relay', explanation_key: 'workflow.medium_relay', fallback: false,
    size_changed: null, explanation_codes: ['medium_relay'], substitutions: [],
  };
  const models = { models: [{ provider: 'codex_sub', model: 'test', effort: 'high', spec: 'codex_sub:test@high', label: 'Test' }], auto_selected: 'codex_sub:test@high' };
  const turn: BrainstormTurnResult = {
    reply: 'Retry', rfc_markdown: '# draft', blueprint: { title: 'Draft', summary: '', deliverables: [], touched_areas: [], verification_plan: [], readiness_score: 80, ready_to_launch: true },
    provider_used: null, offline: false, guide: { question: '', options: [], checklist: [], size: 'medium' },
    error: 'timeout', retryable: true, responding_model: null, requested_model: 'codex_sub:test@high', recommendation,
  };
  const patch = { workflow: { lineup: { roles: { planner: null } }, launch_request_id: 'launch-1' } };
  const chat = {
    messages: [{ role: 'user' as const, content: 'Revise' }], requested_l0_model: 'codex_sub:test@high',
    latest_rfc_draft: '# edited', revision_context: { prior_rfc: '# draft', requested_changes: 'Add tests', failure_context: 'Check failed' },
    previous_lineup: { roles: { planner: 'codex_sub' }, model_overrides: {}, size: 'medium' as const },
  };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json({ session }))
    .mockResolvedValueOnce(Response.json({ session }))
    .mockResolvedValueOnce(Response.json({ session }))
    .mockResolvedValueOnce(Response.json(models))
    .mockResolvedValueOnce(Response.json(turn));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();
  await expect(client.getGuidedSession()).resolves.toEqual(session);
  await expect(client.saveGuidedSession(patch)).resolves.toEqual(session);
  await expect(client.resetGuidedSession()).resolves.toEqual(session);
  await expect(client.getL0Models()).resolves.toEqual(models);
  await expect(client.brainstormChat(chat)).resolves.toEqual(turn);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/guided/session', { method: 'GET' }],
    ['/api/guided/session', jsonRequest('PUT', { session: patch })],
    ['/api/guided/session/reset', jsonRequest('POST', {})],
    ['/api/guided/l0-models', { method: 'GET' }],
    ['/api/brainstorm/chat', jsonRequest('POST', chat)],
  ]);
});

test('M3 keyed launch reuses the request ID and exposes nullable replay daemon PID', async () => {
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json({ run_id: 'r1', daemon_pid: 42, status: 'STARTED' }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ run_id: 'r1', daemon_pid: null, status: 'RUNNING', reused: true }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();
  const payload = { launch_request_id: 'stable-key', mode: 'overnight' as const, lineup: { roles: { planner: 'codex_sub' }, model_overrides: {} }, preset: 'solo_coder_3tier' };
  if (false) {
    // @ts-expect-error A structured lineup cannot be mixed with legacy override fields.
    client.startGuidedRun({ ...payload, model_overrides: { planner: 'codex_sub:test' } });
  }
  await expect(client.startGuidedRun(payload)).resolves.toMatchObject({ run_id: 'r1', daemon_pid: 42 });
  const replay = await client.startGuidedRun(payload);
  expect(replay).toEqual({ run_id: 'r1', daemon_pid: null, status: 'RUNNING', reused: true });
  for (const [, options] of fetchImpl.mock.calls.slice(1)) {
    expect(JSON.parse(String(options?.body))).toEqual(payload);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
});

test.each(['revert_revision', 'abandon_all', 'undo'] as const)('M3 rollback sends the explicit %s mode', async (mode) => {
  const body = { ok: true, run_id: 'r', mode, status: 'PAUSED', restored_to: 'abc', base_branch: 'main', base_head: 'abc' };
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json(body));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();
  await expect(client.rollbackRun('r', mode)).resolves.toEqual(body);
  expect(fetchImpl.mock.calls[1]).toEqual(['/api/runs/r/rollback', jsonRequest('POST', { mode, note: '' })]);
});

test('M3 run reads expose lineage and preserve launch preflight recovery details', async () => {
  expectTypeOf<ReturnType<BatonApiClient['listRuns']>>().toEqualTypeOf<Promise<RunListItem[]>>();
  expectTypeOf<ReturnType<BatonApiClient['getRun']>>().toEqualTypeOf<Promise<LiveRunSnapshot>>();
  expectTypeOf<ReturnType<BatonApiClient['getLatestRun']>>().toEqualTypeOf<Promise<LiveRunSnapshot>>();
  const lineage = { parent_run_id: 'parent', base_ref: 'main', start_sha: 'aaa', result_sha: 'bbb', launch_request_id: 'key' };
  const run = { id: 'r', status: 'SUPERSEDED', mode: 'overnight', created_at: 1, updated_at: 2, finished_at: 2, elapsed_sec: 1, passed_tasks: 0, total_tasks: 1, passed_milestones: 0, total_milestones: 1, ...lineage };
  const snapshot = { run, milestones: [], tasks: [], events: [], quotas: [] };
  const fallback = { mode: 'overnight', preset: null, lineup: null, size: 'medium', reason_code: 'no_ready_provider', explanation_key: 'workflow.no_ready_provider', fallback: true, size_changed: null, explanation_codes: ['no_ready_provider'], substitutions: [] };
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json({ runs: [run] }))
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ error: 'Not ready', code: 'LAUNCH_PREFLIGHT', codes: ['no_ready_provider'], fallback }, { status: 409 }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();
  expect((await client.listLineageRuns())[0]).toMatchObject({ ...lineage, status: 'SUPERSEDED' });
  expect((await client.getLineageRun('r')).run).toMatchObject(lineage);
  expect((await client.getLatestLineageRun()).run).toMatchObject(lineage);
  expect(fetchImpl.mock.calls.slice(1, 4).map(([url]) => url)).toEqual(['/api/runs', '/api/runs/r', '/api/runs/latest']);
  await expect(client.startGuidedRun({ launch_request_id: 'key', mode: 'panel' })).rejects.toMatchObject({
    code: 'LAUNCH_PREFLIGHT', data: { codes: ['no_ready_provider'], fallback },
  });
});

test('M3 lineage operations preserve success variants and structured failures', async () => {
  const run = 'run /1';
  const base = { ok: true, run_id: run, action: 'approve', status: 'COMPLETED', backup_tag: 'backup', base_branch: 'main', base_head: 'abc', merged_commit: 'abc', changed_files: ['app.ts'], gates: [] };
  const gate = { command: 'npm test', passed: false, exit_code: 1, stdout: '', stderr: 'failed', duration_sec: 1 };
  const revision = { ok: true, run_id: run, action: 'revise', status: 'SUPERSEDED', backup_tag: null, base_branch: 'main', base_head: 'abc', revisions_path: 'revisions.md', revision_run_id: 'child', revision_status: 'PENDING', daemon_pid: 7 };
  const rollback = { ok: true, run_id: run, mode: 'revert_revision', status: 'PAUSED', restored_to: 'abc', base_branch: 'main', base_head: 'def' };
  const stopped = { ok: true, run_id: run, status: 'SUPERSEDED', failed_tasks: [{ id: 'T1' }], last_errors: { T1: 'failed' }, current_sha: 'abc', run_summary: 'Stopped' };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json({ ...base, reintegrated: false }))
    .mockResolvedValueOnce(Response.json({ ...base, reintegrated: true }))
    .mockResolvedValueOnce(Response.json({ error: 'Conflict', code: 'INTEGRATION_CONFLICT', conflicts: ['app.ts'], base_head: 'def' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ error: 'Gate failed', code: 'GATE_FAILED', gates: [gate] }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ error: 'Base moved', code: 'BASE_MOVED', base_head: 'new' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json(revision))
    .mockResolvedValueOnce(Response.json(rollback))
    .mockResolvedValueOnce(Response.json(stopped));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();
  expect((await client.approveAndMerge(run)).kind).toBe('merged');
  expect((await client.approveAndMerge(run)).kind).toBe('reintegrated');
  expect(await client.approveAndMerge(run)).toMatchObject({ kind: 'conflict', conflicts: ['app.ts'], base_head: 'def', error: { code: 'INTEGRATION_CONFLICT' } });
  expect(await client.approveAndMerge(run)).toMatchObject({ kind: 'gate_failed', gates: [gate], error: { code: 'GATE_FAILED' } });
  await expect(client.approveAndMerge(run)).rejects.toMatchObject({ code: 'BASE_MOVED', data: { base_head: 'new' } });
  await expect(client.requestChanges(run, 'Add tests')).resolves.toEqual(revision);
  await expect(client.rollbackRun(run, 'revert_revision', 'undo')).resolves.toEqual(rollback);
  await expect(client.stopAndReplan(run, 12)).resolves.toEqual(stopped);
  expect(fetchImpl.mock.calls.slice(-3)).toEqual([
    ['/api/runs/run%20%2F1/request-changes', jsonRequest('POST', { note: 'Add tests' })],
    ['/api/runs/run%20%2F1/rollback', jsonRequest('POST', { mode: 'revert_revision', note: 'undo' })],
    ['/api/runs/run%20%2F1/stop-and-replan', jsonRequest('POST', { timeout_sec: 12 })],
  ]);
});

test('serves presets and graph operations offline after a rejected probe', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Offline'));
  const client = new BatonApiClient('', fetchImpl);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await expect(client.init()).resolves.toBe('demo');
    expect(client.health).toBeNull();
    const presets = await client.listPresets();
    expect(presets.map(({ id }) => id)).toEqual([
      'flagship_4tier', 'solo_coder_3tier', 'starter_2tier', 'review_only_audit',
      'claude_only_3tier', 'codex_only_3tier', 'deepseek_bulk_factory', 'specialist_panel',
    ]);
    expect(filterPresets(presets, 'panel').map(({ id }) => id)).toEqual(['specialist_panel']);
    await expect(client.simulate(specialist_panel, 'happy_path')).resolves.toMatchObject({ status: 'completed' });
    for (const { id, graph, ...summary } of presets) {
      expect(summary).toMatchObject({
        category: graph.category,
        cost_tier: graph.cost_tier,
        required_providers: graph.required_providers,
        host_ready: false,
        missing_providers: graph.required_providers,
        valid: true,
      });
      await expect(client.getPreset(id)).resolves.toBe(graph);
    }
    await expect(client.getPreset('starter_2tier')).resolves.toEqual(starter_2tier);
    await expect(client.getPreset('unknown')).rejects.toMatchObject({ name: 'ApiError', status: 404 });
    await expect(client.validate(starter_2tier)).resolves.toMatchObject({ valid: true, errors: [] });
    await expect(client.simulate(starter_2tier, 'gate_retry')).resolves.toMatchObject({
      status: 'completed', visited_nodes: ['plan', 'worker', 'gate', 'worker', 'gate', 'final'],
    });
    await expect(client.updateRole('bulk_worker', { model: 'example' })).rejects.toMatchObject({
      name: 'ApiError', status: 0, message: 'Not available in standalone demo',
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('/api/health', {
      method: 'GET', signal: expect.any(AbortSignal),
    });
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

test.each([
  ['a non-200 status', () => Response.json(health, { status: 201 })],
  ['an unhealthy response', () => Response.json({ status: 'unavailable' })],
  ['a null JSON body', () => Response.json(null)],
  ['invalid JSON', () => new Response('<html>Static site</html>')],
])('returns to demo on a later probe with %s', async (_, response) => {
  const client = new BatonApiClient('', healthyFetch().mockResolvedValueOnce(response()));

  await expect(client.init()).resolves.toBe('local');
  await expect(client.init()).resolves.toBe('demo');
  expect(client.mode).toBe('demo');
  expect(client.health).toBeNull();
});

test('aborts an unresponsive health probe at 1500 ms', async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const client = new BatonApiClient('', fetchImpl);
    const probing = client.init();
    const signal = fetchImpl.mock.calls[0][1]?.signal;

    await vi.advanceTimersByTimeAsync(1499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(probing).resolves.toBe('demo');
    expect(client.health).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  [404, 'nope', () => Response.json({ error: 'nope' }, { status: 404 })],
  [503, 'Service Unavailable', () => new Response('Unavailable', { status: 503, statusText: 'Service Unavailable' })],
])('surfaces HTTP %i as ApiError with the message %s', async (status, message, response) => {
  const client = new BatonApiClient('', healthyFetch().mockResolvedValueOnce(response()));
  await client.init();

  const result = client.getPreset('missing');
  await expect(result).rejects.toBeInstanceOf(ApiError);
  await expect(result).rejects.toMatchObject({ status, message });
  expect(client.mode).toBe('local');
});

test('loads a preset and sends local graph operations as JSON', async () => {
  const graph = starter_2tier;
  const validation: GraphValidationResult = {
    valid: true, errors: [], warnings: [], entry_nodes: ['plan'], has_cycles: true,
  };
  const simulation: SimulationResult = { status: 'halted', visited_nodes: ['plan'], trace: [] };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json({ graph }))
    .mockResolvedValueOnce(Response.json(validation))
    .mockResolvedValueOnce(Response.json(simulation));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.getPreset(graph.id)).resolves.toEqual(graph);
  await expect(client.validate(graph)).resolves.toEqual(validation);
  await expect(client.simulate(graph, 'happy_path')).resolves.toEqual(simulation);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    [`/api/presets/${graph.id}`, { method: 'GET' }],
    ['/api/graph/validate', jsonRequest('POST', { graph })],
    ['/api/graph/simulate', jsonRequest('POST', { graph, scenario: 'happy_path' })],
  ]);
});

test('reads and updates roles with CLI-style fallback targets', async () => {
  const role = {
    provider: 'host_native', model: 'initial', fallback: [{ provider: 'codex_sub', model: 'backup' }],
  };
  const config = { config_path: '.baton/baton.toml', providers: {}, roles: { bulk_worker: role } };
  const payload = { model: 'updated' };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json(config))
    .mockResolvedValueOnce(Response.json({ role_name: 'bulk_worker', role: { ...role, ...payload } }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  const roleConfig = { ...role, fallback: ['codex_sub:backup'] };
  await expect(client.getRoles()).resolves.toEqual({ ...config, roles: { bulk_worker: roleConfig } });
  await expect(client.updateRole('bulk_worker', payload)).resolves.toEqual({ ...roleConfig, ...payload });
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/config/roles', { method: 'GET' }],
    ['/api/config/roles/bulk_worker', jsonRequest('PUT', payload)],
  ]);
});

test('reads the roles and model catalog and saves the budget profile over HTTP', async () => {
  const budget: BudgetConfigResponse = {
    budget_profile: 'balanced',
    model_catalog: [{
      provider: 'codex_sub', model: 'demo@high', efforts: ['low', 'high', 'max'],
      cost_tier: 'standard', ready: true, detail: 'CLI available',
    }],
  };
  const role = {
    provider: 'codex_sub', model: 'demo@high',
    fallback: [{ provider: 'claude_sub', model: 'backup' }, 'codex_sub:other'],
  };
  const config = {
    ...budget,
    config_path: '.baton/baton.toml',
    providers: { codex_sub: { command: ['codex', 'exec'], max_concurrency: 1 } },
    roles: { bulk_worker: role },
  };
  const updated: BudgetConfigResponse = { ...budget, budget_profile: 'eco' };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json(config))
    .mockResolvedValueOnce(Response.json(updated));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.getRolesConfig()).resolves.toEqual({
    ...config,
    roles: { bulk_worker: { ...role, fallback: ['claude_sub:backup', 'codex_sub:other'] } },
  });
  await expect(client.setBudgetProfile('eco')).resolves.toEqual(updated);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/config/roles', { method: 'GET' }],
    ['/api/config/budget', jsonRequest('PUT', { budget_profile: 'eco' })],
  ]);
});

// Golden example for Studio: load, sync, then save or clear overrides by model ID.
test('loads, syncs, and saves local pricing through the M2 REST API', async () => {
  const builtin: PricingModelEntry = {
    model: 'gpt-4o', input_per_1m: 2.5, output_per_1m: 10, cached_input_per_1m: 1.25, source: 'builtin',
  };
  const initial: PricingStatusResponse = {
    models: [builtin],
    cache: {
      path: '/local/pricing_cache.json',
      fetched_at: null,
      age_sec: null,
      stale: true,
      refresh_interval_hours: 24,
      auto_sync: true,
      source_url: 'https://example.test/prices.json',
    },
    custom_path: '/local/custom_pricing.json',
  };
  const wireCache = { ...initial.cache, fetched_at: 1_700_000_000.125, age_sec: 0, stale: false };
  const catalog: PricingStatusResponse = {
    ...initial,
    models: [{ ...builtin, source: 'official_cache' }],
    cache: { ...wireCache, fetched_at: '2023-11-14T22:13:20.125Z' },
  };
  const synced: PricingSyncResponse = {
    ok: true, fetched: true, skipped_fresh: false, model_count: 1, error: null, catalog,
  };
  const failed: PricingSyncResponse = {
    ok: false, fetched: false, skipped_fresh: false, model_count: 0, error: 'Pricing feed offline', catalog: initial,
  };
  const rates = { input_per_1m: 1.5, output_per_1m: 6, cached_input_per_1m: 0.15 };
  const updates: CustomPricingUpdate = { 'gpt-4o': rates, 'previous-custom-model': null };
  const saved: PricingStatusResponse = { ...catalog, models: [{ ...builtin, ...rates, source: 'custom' }] };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json(initial))
    .mockResolvedValueOnce(Response.json(failed))
    .mockResolvedValueOnce(Response.json({ ...synced, catalog: { ...catalog, cache: wireCache } }))
    .mockResolvedValueOnce(Response.json({ ...saved, cache: wireCache }))
    .mockResolvedValueOnce(Response.json({ ...saved, cache: wireCache }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.getPricing()).resolves.toEqual(initial);
  await expect(client.syncPricing()).resolves.toEqual(failed);
  await expect(client.syncPricing(true)).resolves.toEqual(synced);
  await expect(client.saveCustomPricing(updates)).resolves.toEqual(saved);
  await expect(client.getPricing()).resolves.toEqual(saved);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/pricing', { method: 'GET' }],
    ['/api/pricing/sync', jsonRequest('POST', { force: false })],
    ['/api/pricing/sync', jsonRequest('POST', { force: true })],
    ['/api/pricing/custom', jsonRequest('PUT', { updates })],
    ['/api/pricing', { method: 'GET' }],
  ]);
});

test('surfaces a local custom pricing HTTP error as ApiError', async () => {
  const message = 'input_per_1m must be a finite non-negative number';
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json({ error: message }, { status: 400 }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  const updates = { 'gpt-4o': { input_per_1m: -1, output_per_1m: 6, cached_input_per_1m: 0.15 } };
  const result = client.saveCustomPricing(updates);
  await expect(result).rejects.toBeInstanceOf(ApiError);
  await expect(result).rejects.toMatchObject({ status: 400, message });
});

test('saves, syncs, and resets demo pricing in client memory without fetching', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  const initial = await client.getPricing();
  expect(initial.models.length).toBeGreaterThan(0);
  expect(initial.models.every(({ source }) => source === 'builtin')).toBe(true);
  expect(initial.cache).toMatchObject({ fetched_at: null, age_sec: null, refresh_interval_hours: 24, auto_sync: false });

  const { model } = initial.models[0];
  const rates = { input_per_1m: 1.5, output_per_1m: 6, cached_input_per_1m: 0 };
  const saved = await client.saveCustomPricing({ [model]: rates });
  expect(saved.models.find((entry) => entry.model === model)).toEqual({ model, ...rates, source: 'custom' });
  expect(saved.models).toHaveLength(initial.models.length);

  const extra = { model: 'custom-model', ...rates, source: 'custom' };
  const extended = await client.saveCustomPricing({ [extra.model]: rates });
  expect(extended.models).toHaveLength(saved.models.length + 1);
  expect(extended.models).toEqual(expect.arrayContaining([...saved.models, extra]));
  await expect(client.getPricing()).resolves.toEqual(extended);
  await expect(new BatonApiClient('', fetchImpl).getPricing()).resolves.toEqual(initial);
  await expect(client.syncPricing(true)).resolves.toEqual({
    ok: true, fetched: false, skipped_fresh: true, model_count: extended.models.length, error: null, catalog: extended,
  });

  await expect(client.saveCustomPricing({ [extra.model]: null })).resolves.toEqual(saved);
  await expect(client.saveCustomPricing({ [model]: null })).resolves.toEqual(initial);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects demo rate %s without applying a partial update', async (rate) => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  const initial = await client.getPricing();
  const rates = { input_per_1m: 1.5, output_per_1m: 6, cached_input_per_1m: 0.15 };

  await expect(client.saveCustomPricing({
    'gpt-4o': rates,
    invalid: { ...rates, cached_input_per_1m: rate },
  })).rejects.toMatchObject({ name: 'ApiError', status: 400 });
  await expect(client.getPricing()).resolves.toEqual(initial);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('uses the server Doctor result and its measured latency', async () => {
  const payload = { provider: 'codex_sub', role: 'bulk_worker', model: 'demo@high' };
  const result: DoctorRoleResult = {
    provider: 'codex_sub', ok: false, detail: 'CLI unavailable', latency_ms: 24.5, install_hint: 'Check PATH',
  };
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json(result));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.doctorRole(payload)).resolves.toEqual(result);
  expect(fetchImpl).toHaveBeenLastCalledWith('/api/doctor/role', jsonRequest('POST', payload));
});

test('reads and saves masked credential statuses over HTTP', async () => {
  const initial: CredentialStatus[] = [{
    provider_key: 'OPENAI_API_KEY', configured: false, source: 'none', masked: '',
  }];
  const updates = { OPENAI_API_KEY: 'sample-key-1234' };
  const saved: CredentialStatus[] = [{
    provider_key: 'OPENAI_API_KEY', configured: true, source: 'local_file', masked: 'samp••••1234',
  }];
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json(initial))
    .mockResolvedValueOnce(Response.json(saved));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.listCredentials()).resolves.toEqual(initial);
  await expect(client.saveCredentials(updates)).resolves.toEqual(saved);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/credentials', { method: 'GET' }],
    ['/api/credentials', jsonRequest('POST', { updates })],
  ]);
});

test('uses the server to check RFC markdown and to recommend a team for it', async () => {
  const rfcMarkdown = '# RFC\n\n## Goal\n\nShip it.\n';
  const readiness: RfcReadinessResult = {
    score: 100, safe_for_overnight: true, missing_sections: [], warnings: [], detected_commands: ['python -m unittest'],
  };
  const recommendation = { mode: 'overnight', preset: null, lineup: null, size: 'small', reason_code: 'small_eco',
    explanation_key: 'workflow.small_eco', fallback: false, size_changed: null, explanation_codes: ['size_estimated'],
    substitutions: [], flow: 'lean', flow_reason: 'small_rfc_has_verification' } satisfies WorkflowRecommendation;
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json(readiness))
    .mockResolvedValueOnce(Response.json({ recommendation, readiness }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.checkRfc(rfcMarkdown)).resolves.toEqual(readiness);
  await expect(client.recommendBlueprint(rfcMarkdown)).resolves.toEqual({ recommendation, readiness });
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/rfc/check', jsonRequest('POST', { rfc_markdown: rfcMarkdown })],
    ['/api/guided/recommend', jsonRequest('POST', { rfc_markdown: rfcMarkdown })],
  ]);
});

test('keeps the demo budget profile and model catalog in the client instance', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  const initial = await client.getRolesConfig();

  expect(initial.budget_profile).toBe('balanced');
  expect(initial.roles.brainstorm_and_final_gate.provider).toBe('host_native');
  expect(initial.model_catalog.filter(({ ready }) => ready).map(({ provider }) => provider))
    .toEqual(['host_native']);
  expect(initial.model_catalog).toContainEqual(expect.objectContaining({
    provider: 'codex_sub', ready: false, detail: 'Missing in standalone demo.',
  }));
  await expect(client.setBudgetProfile('eco')).resolves.toEqual({
    budget_profile: 'eco', model_catalog: initial.model_catalog,
  });
  await expect(client.getRolesConfig()).resolves.toEqual({ ...initial, budget_profile: 'eco' });
  await expect(new BatonApiClient('', fetchImpl).getRolesConfig()).resolves.toEqual(initial);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('simulates a five-second Doctor with deterministic readiness and install hints', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  vi.useFakeTimers();
  try {
    const ready = client.doctorRole({ provider: 'host_native', role: 'bulk_worker', model: 'codex_sub:demo' });
    const byRole = client.doctorRole({ role: 'bulk_worker' });
    const byModel = client.doctorRole({ role: 'bulk_worker', model: 'codex_sub:demo' });
    const noSelection = client.doctorRole({});
    const onReady = vi.fn();
    void ready.then(onReady);

    await vi.advanceTimersByTimeAsync(4999);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(ready).resolves.toEqual({
      provider: 'host_native', ok: true, detail: 'Ready in standalone demo.', latency_ms: 5000, install_hint: '',
    });
    await expect(byRole).resolves.toMatchObject({
      provider: 'dsh_opencode', ok: false, latency_ms: 5000, install_hint: expect.stringContaining('DSH'),
    });
    expect((await byRole).install_hint).not.toMatch(/opencode/i);
    await expect(byModel).resolves.toMatchObject({
      provider: 'codex_sub', ok: false, latency_ms: 5000, install_hint: expect.stringContaining('codex login'),
    });
    await expect(noSelection).resolves.toMatchObject({ provider: '', ok: false, latency_ms: 5000 });
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('masks, merges and clears credentials in demo memory', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  const initial = await client.listCredentials();
  expect(initial).toEqual(['GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY'].map(
    (provider_key) => ({ provider_key, configured: false, source: 'none', masked: '' }),
  ));

  const secret = 'sample-key-1234';
  const openAi = { provider_key: 'OPENAI_API_KEY', configured: true, source: 'local_file', masked: 'samp••••1234' };
  const openCode = { provider_key: 'OPENCODE_API_KEY', configured: true, source: 'local_file', masked: '••••' };
  await client.saveCredentials({ OPENAI_API_KEY: secret });
  const saved = await client.saveCredentials({ OPENCODE_API_KEY: 'short' });
  expect(saved).toEqual([initial[0], initial[1], openAi, openCode, initial[4]]);
  expect(JSON.stringify(saved)).not.toContain(secret);
  expect(JSON.stringify(saved)).not.toContain('short');
  await expect(client.listCredentials()).resolves.toEqual(saved);
  await expect(client.saveCredentials({ OPENAI_API_KEY: '' })).resolves.toEqual([
    initial[0], initial[1], initial[2], openCode, initial[4],
  ]);
  await expect(new BatonApiClient('', fetchImpl).listCredentials()).resolves.toEqual(initial);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('scores RFC markdown in demo mode without fetching', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  await expect(client.checkRfc('')).resolves.toEqual({
    score: 0, safe_for_overnight: false,
    missing_sections: ['goal', 'constraints', 'acceptance'], warnings: [], detected_commands: [],
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('loads run data and submits run commands to the local server', async () => {
  const runId = 'run-1';
  const snapshot: LiveRunSnapshot = {
    run: { id: runId }, milestones: [], tasks: [], events: [], quotas: [],
  };
  const runsList = [{
    id: runId,
    status: 'READY_FOR_FINAL_GATE',
    mode: 'overnight',
    created_at: 100,
    updated_at: 200,
    finished_at: 200,
    elapsed_sec: 100,
    passed_tasks: 21,
    total_tasks: 21,
    passed_milestones: 4,
    total_milestones: 4,
  }];
  const report = '# Battle report';
  const zhReport = '# 战报';
  const started = { run_id: runId, daemon_pid: 4242, status: 'STARTED' };
  const resumed = { run_id: runId, daemon_pid: 4243, status: 'RUNNING' };
  const rejected = { run_id: runId, decision: 'reject', daemon_pid: null };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json({ runs: runsList }))
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ run_id: runId, battle_report_markdown: report }))
    .mockResolvedValueOnce(Response.json({ run_id: runId, battle_report_markdown: zhReport }))
    .mockResolvedValueOnce(Response.json(started, { status: 201 }))
    .mockResolvedValueOnce(Response.json(resumed))
    .mockResolvedValueOnce(Response.json(rejected));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  const payload = { rfc_markdown: '# RFC', mode: 'interactive', model_overrides: { bulk_worker: 'example' },
    launch_request_id: 'key-1' } as const;
  await expect(client.listRuns()).resolves.toEqual(runsList);
  await expect(client.getLatestRun()).resolves.toEqual(snapshot);
  await expect(client.getRun(runId)).resolves.toEqual(snapshot);
  await expect(client.getRunReport(runId)).resolves.toBe(report);
  await expect(client.getRunReport(runId, 'zh')).resolves.toBe(zhReport);
  await expect(client.startRun(payload)).resolves.toEqual(started);
  await expect(client.controlRun(runId, 'resume')).resolves.toEqual(resumed);
  await expect(client.resolveRun(runId, 'reject')).resolves.toEqual(rejected);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/runs', { method: 'GET' }],
    ['/api/runs/latest', { method: 'GET' }],
    [`/api/runs/${runId}`, { method: 'GET' }],
    [`/api/runs/${runId}/report`, { method: 'GET' }],
    [`/api/runs/${runId}/report?lang=zh`, { method: 'GET' }],
    ['/api/runs/start', { ...jsonRequest('POST', payload), signal: expect.any(AbortSignal) }],
    [`/api/runs/${runId}/control`, jsonRequest('POST', { action: 'resume' })],
    [`/api/runs/${runId}/resolve`, jsonRequest('POST', { decision: 'reject' })],
  ]);
});

test('launches a specialist panel run with mode panel', async () => {
  const started = { run_id: 'run-panel', daemon_pid: 4244, status: 'queued' };
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json(started, { status: 201 }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  const payload = { rfc_markdown: '# RFC', mode: 'panel', launch_request_id: 'key-2' } as const;
  await expect(client.startRun(payload)).resolves.toEqual(started);
  expect(fetchImpl.mock.calls[1]).toEqual(
    ['/api/runs/start', { ...jsonRequest('POST', payload), signal: expect.any(AbortSignal) }],
  );
});

test('exports a local run case with encoded options and normalizes the backend models', async () => {
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json(goldenCase));
  const client = new BatonApiClient('', fetchImpl);
  await expect(client.init()).resolves.toBe('local');

  const bundle = await client.exportRunCase('run-#1', {
    title: 'Release & review',
    includeReviews: false,
    anonymize: true,
  });

  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    '/api/runs/run-%231/case-export?title=Release+%26+review&include_reviews=0&anonymize=1',
    { method: 'GET' },
  );
  expect(bundle).toEqual({
    ...goldenCase,
    meta: { ...goldenCase.meta, models: ['deepseek-flash', 'plan-default', 'review-default', 'signoff'] },
  });
});

test('uses the backend case export defaults and retains HTTP errors', async () => {
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json({ error: 'Run not found' }, { status: 404 }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.exportRunCase('missing')).rejects.toMatchObject({
    name: 'ApiError', status: 404, message: 'Run not found',
  });
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2, '/api/runs/missing/case-export?include_reviews=1&anonymize=0', { method: 'GET' },
  );
});

test('exports the English Stage 1 sample in demo mode and accepts a custom title', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  const sample = buildOfficialStage1Case('en');

  await expect(client.exportRunCase('demo-run')).resolves.toEqual(sample);
  await expect(client.exportRunCase('demo-run', { title: 'Shared demo' })).resolves.toEqual({
    ...sample, title: 'Shared demo',
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('rejects a malformed successful case export response', async () => {
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json({ ...goldenCase, trace: [] }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.exportRunCase('run-1')).rejects.toMatchObject({
    name: 'ApiError', status: 502, message: expect.stringContaining('trace'),
  });
});

test('returns empty live data and rejects backend-only run operations in demo mode', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);

  await expect(client.getRoles()).resolves.toBeNull();
  await expect(client.listRuns()).resolves.toEqual([]);
  await expect(client.getLatestRun()).resolves.toEqual({
    run: null, milestones: [], tasks: [], events: [], quotas: [], telemetry: null,
  });
  const backendOnly = [
    client.getRun('run-1'),
    client.getRunReport('run-1'),
    client.startRun({ rfc_path: 'RFC.md', launch_request_id: 'key' }),
    client.controlRun('run-1', 'pause'),
    client.resolveRun('run-1', 'approve', 'Reviewed'),
  ];
  await Promise.all(backendOnly.map((result) => expect(result).rejects.toMatchObject({
    name: 'ApiError', status: 0, message: 'Not available in standalone demo',
  })));
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('aborts a hanging startRun request after timeoutMs and rejects with status 408', async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(health))
      .mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }));
    const client = new BatonApiClient('', fetchImpl);
    await client.init();

    const starting = client.startRun({ rfc_markdown: '# RFC', launch_request_id: 'key' }, 15000);
    const rejection = expect(starting).rejects.toMatchObject({
      name: 'ApiError',
      status: 408,
    });
    await vi.advanceTimersByTimeAsync(15000);
    await rejection;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('calls every Guided Studio endpoint with typed payloads', async () => {
  const runId = 'run #7';
  const encodedRun = 'run%20%237';
  const driver: CliDriver = {
    id: 'claude', name: 'Claude Code', tier: 'official', binary: 'claude',
    summary_en: 'Coding CLI.', summary_zh: 'Coding CLI zh.', prereq: ['node'],
    install_cmd: ['npm', 'install', '-g', '@anthropic-ai/claude-code'], login_cmd: ['claude', 'auth', 'login'],
    official_url: 'https://example.test', command_template: ['claude', '-p'], version_cmd: ['claude', '--version'],
    provider_ids: ['claude_sub'], env_keys: ['ANTHROPIC_API_KEY'], auth_check_cmd: null,
  };
  const registry: CliRegistry = { schema_version: 1, drivers: [driver], tags: [] };
  const scan: CliRegistryScanResponse = {
    scan: {
      drivers: [{
        id: 'claude', status: 'ready', binary_path: '/usr/bin/claude', version: '2.0.0',
        prereq_missing: [], reason_en: 'Ready.', reason_zh: 'Ready zh.',
      }],
      http_api_keys_present: [],
      scanned_at: 1_790_000_000,
    },
    lineup: { ready: true, roles: { planner: 'claude_sub' }, source: 'cli', notes_en: 'OK', notes_zh: 'OK zh' },
  };
  const installed: CliInstallResult = {
    id: 'codex', ok: true, command: ['npm', 'install', '-g', '@openai/codex'], returncode: 0, output: '',
  };
  const login: CliLoginResult = {
    id: 'codex', launched: true, command: ['codex', 'login'], message_en: 'Opened.', message_zh: 'Opened zh.',
  };
  const workspace: WorkspaceInfo = { path: '/repo', is_git_repo: false, branch: null, has_commits: false, has_rfc: false };
  const initialized: InitGitResult = { ...workspace, is_git_repo: true, branch: 'main', has_commits: true, created: true };
  const turn: BrainstormTurnResult = {
    reply: 'Understood.',
    rfc_markdown: '# Todo app\n',
    blueprint: {
      title: 'Todo app', summary: 'A small todo app.', deliverables: ['app.py'], touched_areas: ['app.py'],
      verification_plan: ['pytest'], readiness_score: 85, ready_to_launch: true,
    },
    provider_used: null,
    offline: true,
    guide: { question: '', options: [], checklist: [] },
    error: null,
  };
  const detail: RunTaskDetail = {
    run_id: runId, task_id: 'M1/T1', milestone_id: 'M1', title: 'Add API', tier: 'routine', status: 'PASSED',
    summary: 'Passed.', attempts: 1, test_status: 'passed', provider: 'claude_sub', model: 'sonnet',
    elapsed_sec: 12.5, cost_usd: 0.04, changed_files: ['app.py'], review_verdict: 'PASS',
  };
  const resolved: ResolveRunTaskResult = { ok: true, run_id: runId, task_id: 'M1-T2', status: 'RUNNING' };
  const finalized: FinalizeResult = {
    ok: true, run_id: runId, action: 'approve', status: 'COMPLETED', backup_tag: 'baton-backup/run',
    base_branch: 'main', base_head: 'abc123', merged_commit: 'abc123', changed_files: ['app.py'],
  };
  const revised: FinalizeResult = {
    ok: true, run_id: runId, action: 'revise', status: 'PAUSED', backup_tag: null,
    base_branch: 'main', base_head: 'abc123', revisions_path: '/repo/.baton/runs/x/revisions.md',
  };
  const responses = [
    registry, scan, scan, installed, login, workspace, workspace, initialized, turn, detail, resolved,
    finalized, revised,
  ];
  const fetchImpl = healthyFetch();
  for (const body of responses) fetchImpl.mockResolvedValueOnce(Response.json(body));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  const messages = [{ role: 'user', content: 'Build a todo app' }] as const;
  await expect(client.getCliRegistry()).resolves.toEqual(registry);
  await expect(client.scanCliRegistry()).resolves.toEqual(scan);
  await expect(client.scanCliRegistry('/other')).resolves.toEqual(scan);
  await expect(client.installCli({ cliId: 'codex', confirmed: true })).resolves.toEqual(installed);
  await expect(client.loginCli('codex')).resolves.toEqual(login);
  await expect(client.getWorkspaceInfo()).resolves.toEqual(workspace);
  await expect(client.selectWorkspace('/repo')).resolves.toEqual(workspace);
  await expect(client.initGitWorkspace()).resolves.toEqual(initialized);
  await expect(client.brainstormChat({ messages: [...messages], scenario: 'web_app' })).resolves.toEqual(turn);
  await expect(client.getRunTaskDetail(runId, 'M1/T1')).resolves.toEqual(detail);
  await expect(client.resolveRunTask(runId, { taskId: 'M1-T2', choice: 'approve' })).resolves.toEqual(resolved);
  await expect(client.finalizeRun(runId, { action: 'approve' })).resolves.toEqual(finalized);
  await expect(client.finalizeRun(runId, { action: 'revise', note: 'Add tests' })).resolves.toEqual(revised);

  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/cli-registry', { method: 'GET' }],
    ['/api/cli-registry/scan', jsonRequest('POST', {})],
    ['/api/cli-registry/scan', jsonRequest('POST', { repo_path: '/other' })],
    ['/api/cli-registry/install', jsonRequest('POST', { id: 'codex', confirmed: true })],
    ['/api/cli-registry/login', jsonRequest('POST', { id: 'codex' })],
    ['/api/workspace/info', { method: 'GET' }],
    ['/api/workspace/select', jsonRequest('POST', { path: '/repo' })],
    ['/api/workspace/init-git', jsonRequest('POST', {})],
    ['/api/brainstorm/chat', jsonRequest('POST', { messages, scenario: 'web_app' })],
    [`/api/runs/${encodedRun}/tasks/M1%2FT1`, { method: 'GET' }],
    [`/api/runs/${encodedRun}/resolve`, jsonRequest('POST', { task_id: 'M1-T2', choice: 'approve', note: '' })],
    [`/api/runs/${encodedRun}/finalize`, jsonRequest('POST', { action: 'approve', note: '' })],
    [`/api/runs/${encodedRun}/finalize`, jsonRequest('POST', { action: 'revise', note: 'Add tests' })],
  ]);
});

test('reads the handoffs, an artifact and the evidence of a run with encoded path segments', async () => {
  const runId = 'run #7';
  const encodedRun = 'run%20%237';
  const artifactKey = 'M1/T1:worker #2?x';
  const receipt: GateReceipt = {
    event_id: 12, scope: 'task', target_id: 'T1', command: 'npm test', exit_code: 0, passed: true,
    duration_sec: 1.5, output_tail: 'ok', created_at: 100,
  };
  const handoffs: RunHandoffsResponse = {
    run_id: runId,
    handoffs: [{
      id: 'planner>task:T1', from: { kind: 'planner', id: null }, to: { kind: 'task', id: 'T1' },
      recorded: true, event_ids: [10, 11], at: 99,
      invocations: [{
        event_id: 10, artifact_key: artifactKey, role: 'bulk_worker', model: 'flash', side: 'to',
        created_at: 98, status: null, duration_sec: null,
      }],
      changed_files: null, receipts: [receipt], review: null,
      takeover: { status: null, holder: null }, blocked_reason: null,
    }],
  };
  const artifact: RunArtifactResponse = {
    run_id: runId, artifact_key: artifactKey, prompt: { text: 'Do it', truncated: false, bytes: 5 }, output: null,
  };
  const evidence: RunEvidenceResponse = {
    run_id: runId, rfc_available: true,
    criteria: [{ index: 1, text: 'Run `npm test`.', state: 'receipt', result: 'passed', receipts: [receipt], files: [] }],
    run_level_receipts: [],
    summary: { criteria: 1, passed: 1, failed: 0, files_only: 0, not_linked: 0, receipts: 1 },
  };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json(handoffs))
    .mockResolvedValueOnce(Response.json(artifact))
    .mockResolvedValueOnce(Response.json(evidence));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.getRunHandoffs(runId)).resolves.toEqual(handoffs);
  await expect(client.getRunArtifact(runId, artifactKey)).resolves.toEqual(artifact);
  await expect(client.getRunEvidence(runId)).resolves.toEqual(evidence);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    [`/api/runs/${encodedRun}/handoffs`, { method: 'GET' }],
    [`/api/runs/${encodedRun}/artifacts/M1%2FT1%3Aworker%20%232%3Fx`, { method: 'GET' }],
    [`/api/runs/${encodedRun}/evidence`, { method: 'GET' }],
  ]);
});

test('the run evidence reads surface a missing artifact and stay unavailable in demo mode', async () => {
  const fetchImpl = healthyFetch().mockResolvedValueOnce(Response.json({ error: 'Unknown artifact' }, { status: 404 }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();
  await expect(client.getRunArtifact('run-1', 'missing')).rejects.toMatchObject({
    name: 'ApiError', status: 404, message: 'Unknown artifact',
  });

  const demoFetch = vi.fn<typeof fetch>();
  const demo = new BatonApiClient('', demoFetch);
  const calls = [demo.getRunHandoffs('run-1'), demo.getRunArtifact('run-1', 'key'), demo.getRunEvidence('run-1')];
  await Promise.all(calls.map((call) => expect(call).rejects.toMatchObject({
    name: 'ApiError', status: 0, message: 'Not available in standalone demo',
  })));
  expect(demoFetch).not.toHaveBeenCalled();
});

test('installCli sends only the chosen cliId with confirmed: true, even if extra fields are passed', async () => {
  const fetchImpl = healthyFetch().mockResolvedValueOnce(
    Response.json({ id: 'gemini', ok: true, command: ['npm'], returncode: 0, output: '' }),
  );
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  const extra = { cliId: 'gemini', confirmed: true, install_cmd: ['curl', 'https://example.test'] };
  await client.installCli(extra as CliInstallRequest);
  const body: unknown = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
  expect(body).toStrictEqual({ id: 'gemini', confirmed: true });
});

test('Guided endpoints surface backend errors and stay unavailable in demo mode', async () => {
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json({ error: 'Unknown CLI driver' }, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ error: 'Run is RUNNING, not READY_FOR_FINAL_GATE' }, { status: 409 }));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();
  await expect(client.loginCli('nope')).rejects.toMatchObject({
    name: 'ApiError', status: 404, message: 'Unknown CLI driver',
  });
  await expect(client.finalizeRun('run-1', { action: 'approve' })).rejects.toMatchObject({ status: 409 });

  const demoFetch = vi.fn<typeof fetch>();
  const demo = new BatonApiClient('', demoFetch);
  const calls = [
    demo.getCliRegistry(),
    demo.scanCliRegistry(),
    demo.installCli({ cliId: 'claude', confirmed: true }),
    demo.loginCli('claude'),
    demo.getWorkspaceInfo(),
    demo.selectWorkspace('/repo'),
    demo.initGitWorkspace(),
    demo.brainstormChat({ messages: [{ role: 'user', content: 'Hi' }] }),
    demo.recommendBlueprint('# RFC'),
    demo.getRunTaskDetail('run-1', 'T1'),
    demo.resolveRunTask('run-1', { taskId: 'T1', choice: 'reject', note: 'No' }),
    demo.finalizeRun('run-1', { action: 'rollback' }),
  ];
  await Promise.all(calls.map((call) => expect(call).rejects.toMatchObject({
    name: 'ApiError', status: 0, message: 'Not available in standalone demo',
  })));
  expect(demoFetch).not.toHaveBeenCalled();
});
