import { expect, test, vi } from 'vitest';
import { presetToItem, starter_2tier } from '../data/presets';
import goldenCase from '../engine/__fixtures__/goldenCase.json';
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
  RfcBrainstormResult,
  SimulationResult,
} from '../types/graph';
import { ApiError, BatonApiClient } from './client';

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
      'claude_only_3tier', 'codex_only_3tier', 'deepseek_bulk_factory',
    ]);
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

test('uses the server to brainstorm and check RFC markdown', async () => {
  const payload = {
    goal: 'Ship a deterministic ready-to-run RFC with offline scoring.',
    constraints: 'Use existing dependencies.',
    acceptance_cmd: 'python -m unittest',
    non_goals: 'Build a new UI.',
  };
  const generated: RfcBrainstormResult = {
    rfc_markdown: [
      '# RFC', '',
      '## Goal', '', payload.goal, '',
      '## Constraints', '', payload.constraints, '',
      '## Non-goals', '', payload.non_goals, '',
      '## Acceptance Criteria', '', '1. The verification command exits successfully.', '',
      '```bash', payload.acceptance_cmd, '```', '',
    ].join('\n'),
    readiness: {
      score: 100, safe_for_overnight: true, missing_sections: [], warnings: [],
      detected_commands: ['python -m unittest'],
    },
  };
  const fetchImpl = healthyFetch()
    .mockResolvedValueOnce(Response.json(generated))
    .mockResolvedValueOnce(Response.json(generated.readiness));
  const client = new BatonApiClient('', fetchImpl);
  await client.init();

  await expect(client.brainstormRfc(payload)).resolves.toEqual(generated);
  await expect(client.checkRfc(generated.rfc_markdown)).resolves.toEqual(generated.readiness);
  expect(fetchImpl.mock.calls.slice(1)).toEqual([
    ['/api/rfc/brainstorm', jsonRequest('POST', payload)],
    ['/api/rfc/check', jsonRequest('POST', { rfc_markdown: generated.rfc_markdown })],
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
      provider: 'dsh_opencode', ok: false, latency_ms: 5000, install_hint: expect.stringContaining('OPENCODE_API_KEY'),
    });
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
  expect(initial).toEqual(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY'].map(
    (provider_key) => ({ provider_key, configured: false, source: 'none', masked: '' }),
  ));

  const secret = 'sample-key-1234';
  const openAi = { provider_key: 'OPENAI_API_KEY', configured: true, source: 'local_file', masked: 'samp••••1234' };
  const openCode = { provider_key: 'OPENCODE_API_KEY', configured: true, source: 'local_file', masked: '••••' };
  await client.saveCredentials({ OPENAI_API_KEY: secret });
  const saved = await client.saveCredentials({ OPENCODE_API_KEY: 'short' });
  expect(saved).toEqual([initial[0], openAi, openCode, initial[3]]);
  expect(JSON.stringify(saved)).not.toContain(secret);
  expect(JSON.stringify(saved)).not.toContain('short');
  await expect(client.listCredentials()).resolves.toEqual(saved);
  await expect(client.saveCredentials({ OPENAI_API_KEY: '' })).resolves.toEqual([
    initial[0], initial[1], openCode, initial[3],
  ]);
  await expect(new BatonApiClient('', fetchImpl).listCredentials()).resolves.toEqual(initial);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('brainstorms and scores a runnable RFC in demo mode without fetching', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  await expect(client.checkRfc('')).resolves.toEqual({
    score: 0, safe_for_overnight: false,
    missing_sections: ['goal', 'constraints', 'acceptance'], warnings: [], detected_commands: [],
  });

  const { rfc_markdown, readiness } = await client.brainstormRfc({
    goal: 'Add a deterministic RFC readiness score and a command detection report.',
    constraints: 'Use the existing frontend runtime.',
    acceptance_cmd: 'python -m unittest',
  });
  expect(rfc_markdown).toContain('```bash\npython -m unittest\n```');
  expect(readiness).toEqual({
    score: 100, safe_for_overnight: true, missing_sections: [], warnings: [],
    detected_commands: ['python -m unittest'],
  });
  await expect(client.checkRfc(rfc_markdown)).resolves.toEqual(readiness);
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

  const payload = { rfc_markdown: '# RFC', mode: 'interactive', model_overrides: { bulk_worker: 'example' } } as const;
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
    ['/api/runs/start', jsonRequest('POST', payload)],
    [`/api/runs/${runId}/control`, jsonRequest('POST', { action: 'resume' })],
    [`/api/runs/${runId}/resolve`, jsonRequest('POST', { decision: 'reject' })],
  ]);
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
    client.startRun({ rfc_path: 'RFC.md' }),
    client.controlRun('run-1', 'pause'),
    client.resolveRun('run-1', 'approve', 'Reviewed'),
  ];
  await Promise.all(backendOnly.map((result) => expect(result).rejects.toMatchObject({
    name: 'ApiError', status: 0, message: 'Not available in standalone demo',
  })));
  expect(fetchImpl).not.toHaveBeenCalled();
});
